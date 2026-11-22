import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import type { BoardJob, BoardSource } from '@careeros/shared';
import {
  BOARD_RETRY,
  boardJobProcessor,
  type CrawlBoardJobData,
} from './crawl-board.processor';
import {
  SourceNotConfiguredError,
  SourceUnreachableError,
} from '../adapters/fetch-failure';

/**
 * The crawl-board processor under real BullMQ, against a real Redis: the final attempt, a retry that
 * recovers, a permanent failure, a source with no key, and recording failures, together. It proves
 * what the unit tests can only assume: what `job.attemptsMade` is on each attempt, and that
 * UnrecoverableError really stops the retries.
 *
 * Needs a THROWAWAY Redis, never a live one:
 *   W5_INT_REDIS_URL  e.g. redis://127.0.0.1:<port>
 * The suite refuses to run, before it touches anything, unless:
 *   - the URL is not the application's REDIS_URL, and its port is not 6379 (the live Redis);
 *   - the server holds the marker `careeros:throwaway` = `w5`.
 * It uses its own queue, w5-int-crawl-board, and removes it at the end. Without the variable the
 * suite is skipped.
 */

const REDIS = process.env.W5_INT_REDIS_URL;
const describeRedis = REDIS ? describe : describe.skip;
const QUEUE = 'w5-int-crawl-board';
/** BOARD_RETRY's attempts, with a 50 ms backoff instead of +5/+10/+20/+40/+80 minutes. */
const FAST = {
  attempts: BOARD_RETRY.attempts,
  backoff: { type: 'fixed' as const, delay: 50 },
};
const ONE_JOB = [
  {
    company: { name: 'Acme' },
    job: { externalId: 'e1' },
  } as unknown as BoardJob,
];
const OUTAGE = new SourceUnreachableError(
  'jooble',
  'transient',
  6,
  'EAI_AGAIN ×6',
);
const OUTAGE_REASON = 'jooble: all 6 requests failed (EAI_AGAIN ×6)';
const REFUSED = new SourceUnreachableError(
  'jooble',
  'permanent',
  6,
  'HTTP 401 ×6',
);
const REFUSED_REASON = 'jooble: all 6 requests failed (HTTP 401 ×6)';

function fakeApi() {
  return {
    ingestBoardJobs: jest.fn().mockResolvedValue({
      crawlRunId: 'r1',
      found: 1,
      created: 1,
      updated: 0,
      removed: 0,
      duplicates: 0,
    }),
    recordBoardFailure: jest.fn().mockResolvedValue({ crawlRunId: 'f1' }),
  };
}

/** A fetcher that plays `script` in order, one step per attempt: a job list, or an error to throw. */
function scripted(script: (BoardJob[] | Error)[]) {
  let calls = 0;
  const fetcher = () => {
    const step = script[Math.min(calls, script.length - 1)];
    calls++;
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  };
  return { fetcher, calls: () => calls };
}

describeRedis('crawl-board under real BullMQ (W5 fix)', () => {
  const connections: IORedis[] = [];
  const connect = () => {
    const c = new IORedis(REDIS as string, { maxRetriesPerRequest: null });
    connections.push(c);
    return c;
  };
  let queue: Queue<CrawlBoardJobData>;

  beforeAll(async () => {
    if (
      REDIS === process.env.REDIS_URL ||
      new URL(REDIS as string).port === '6379' ||
      new URL(REDIS as string).port === ''
    ) {
      throw new Error(
        'refusing to run: W5_INT_REDIS_URL is the application Redis, or on its port',
      );
    }
    const probe = connect();
    if ((await probe.get('careeros:throwaway')) !== 'w5') {
      throw new Error(
        'refusing to run: this Redis is not marked careeros:throwaway = w5',
      );
    }
    queue = new Queue<CrawlBoardJobData>(QUEUE, { connection: connect() });
  });
  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await queue?.close();
    await Promise.all(connections.map((c) => c.quit()));
  });

  /** Runs one job to its end under a real Worker; returns the job's final state. */
  async function runJob(
    fetcher: () => Promise<BoardJob[]>,
    api: ReturnType<typeof fakeApi>,
    opts: object = FAST,
  ) {
    const fetchers = Object.fromEntries(
      (
        [
          'remoteok',
          'hn-hiring',
          'adzuna',
          'jooble',
          'freehire',
        ] as BoardSource[]
      ).map((b) => [b, fetcher]),
    ) as Record<BoardSource, () => Promise<BoardJob[]>>;
    const worker = new Worker<CrawlBoardJobData>(
      QUEUE,
      boardJobProcessor(api, fetchers),
      {
        connection: connect(),
        concurrency: 1,
      },
    );
    try {
      const added = await queue.add('w5-int', { board: 'jooble' }, opts);
      const deadline = Date.now() + 20_000;
      let state = await added.getState();
      while (state !== 'completed' && state !== 'failed') {
        if (Date.now() > deadline)
          throw new Error(`job still ${state} after 20 s`);
        await new Promise((r) => setTimeout(r, 25));
        state = await added.getState();
      }
      const done = await Job.fromId(queue, added.id as string);
      return {
        state,
        failedReason: done?.failedReason,
        returnvalue: done?.returnvalue as unknown,
      };
    } finally {
      await worker.close();
    }
  }

  beforeEach(() =>
    jest.spyOn(console, 'log').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());

  it('a retry that recovers: completed on the 2nd attempt, no FAILED run, one ingest', async () => {
    const api = fakeApi();
    const f = scripted([OUTAGE, ONE_JOB]);

    const end = await runJob(f.fetcher, api);

    expect(end.state).toBe('completed');
    expect(f.calls()).toBe(2);
    expect(api.recordBoardFailure).not.toHaveBeenCalled();
    expect(api.ingestBoardJobs).toHaveBeenCalledTimes(1);
    expect(api.ingestBoardJobs).toHaveBeenCalledWith('jooble', ONE_JOB);
  }, 30_000);

  it(`an outage through all ${BOARD_RETRY.attempts} attempts: failed after ${BOARD_RETRY.attempts} fetches, exactly one FAILED run`, async () => {
    const api = fakeApi();
    const f = scripted([OUTAGE]);

    const end = await runJob(f.fetcher, api);

    expect(end.state).toBe('failed');
    expect(f.calls()).toBe(BOARD_RETRY.attempts);
    expect(api.recordBoardFailure).toHaveBeenCalledTimes(1);
    expect(api.recordBoardFailure).toHaveBeenCalledWith(
      'jooble',
      OUTAGE_REASON,
    );
    expect(end.failedReason).toBe(OUTAGE_REASON);
    expect(api.ingestBoardJobs).not.toHaveBeenCalled();
  }, 30_000);

  it('a permanent failure: failed after 1 fetch (no retry), exactly one FAILED run', async () => {
    const api = fakeApi();
    const f = scripted([REFUSED]);

    const end = await runJob(f.fetcher, api);

    expect(end.state).toBe('failed');
    expect(f.calls()).toBe(1);
    expect(api.recordBoardFailure).toHaveBeenCalledTimes(1);
    expect(api.recordBoardFailure).toHaveBeenCalledWith(
      'jooble',
      REFUSED_REASON,
    );
    expect(end.failedReason).toBe(REFUSED_REASON);
  }, 30_000);

  it('an outage, then a refusal: failed on the 2nd attempt, one FAILED run with the refusal', async () => {
    const api = fakeApi();
    const f = scripted([OUTAGE, REFUSED]);

    const end = await runJob(f.fetcher, api);

    expect(end.state).toBe('failed');
    expect(f.calls()).toBe(2);
    expect(api.recordBoardFailure).toHaveBeenCalledTimes(1);
    expect(api.recordBoardFailure).toHaveBeenCalledWith(
      'jooble',
      REFUSED_REASON,
    );
  }, 30_000);

  it('a source with no key: completed after 1 fetch attempt, nothing ingested or recorded', async () => {
    const api = fakeApi();
    const f = scripted([
      new SourceNotConfiguredError('jooble', 'JOOBLE_API_KEY'),
    ]);

    const end = await runJob(f.fetcher, api);

    expect(end.state).toBe('completed');
    expect(end.returnvalue).toEqual({
      skipped: 'not-configured',
      board: 'jooble',
    });
    expect(f.calls()).toBe(1);
    expect(api.ingestBoardJobs).not.toHaveBeenCalled();
    expect(api.recordBoardFailure).not.toHaveBeenCalled();
  }, 30_000);

  it('a genuine zero: completed after 1 fetch, ingested as [], nothing recorded', async () => {
    const api = fakeApi();
    const f = scripted([[]]);

    const end = await runJob(f.fetcher, api);

    expect(end.state).toBe('completed');
    expect(f.calls()).toBe(1);
    expect(api.ingestBoardJobs).toHaveBeenCalledWith('jooble', []);
    expect(api.recordBoardFailure).not.toHaveBeenCalled();
  }, 30_000);

  it(`recording fails on the last of ${BOARD_RETRY.attempts} attempts: the job still fails with the classified reason`, async () => {
    const api = fakeApi();
    api.recordBoardFailure.mockRejectedValue(
      new Error('API POST /internal/boards/failed -> 503: unavailable'),
    );
    const f = scripted([OUTAGE]);

    const end = await runJob(f.fetcher, api);

    expect(end.state).toBe('failed');
    expect(f.calls()).toBe(BOARD_RETRY.attempts);
    expect(api.recordBoardFailure).toHaveBeenCalledTimes(1);
    expect(end.failedReason).toBe(OUTAGE_REASON);
  }, 30_000);

  it('recording fails on a permanent failure: still no retry, the job fails with the classified reason', async () => {
    const api = fakeApi();
    api.recordBoardFailure.mockRejectedValue(
      new Error('API POST /internal/boards/failed -> 503: unavailable'),
    );
    const f = scripted([REFUSED]);

    const end = await runJob(f.fetcher, api);

    expect(end.state).toBe('failed');
    expect(f.calls()).toBe(1);
    expect(end.failedReason).toBe(REFUSED_REASON);
  }, 30_000);
});
