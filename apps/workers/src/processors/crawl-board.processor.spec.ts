import { UnrecoverableError, type Job } from 'bullmq';
import { BOARD_SOURCES, type BoardJob } from '@careeros/shared';
import {
  BOARDS,
  boardJobProcessor,
  crawlBoard,
  type CrawlBoardJobData,
} from './crawl-board.processor';
import {
  FetchTally,
  SourceNotConfiguredError,
  SourceUnreachableError,
} from '../adapters/fetch-failure';

function fakeApi() {
  return {
    ingestBoardJobs: jest.fn().mockResolvedValue({
      crawlRunId: 'r1',
      found: 0,
      created: 0,
      updated: 0,
      removed: 0,
      duplicates: 0,
    }),
    recordBoardFailure: jest.fn().mockResolvedValue({ crawlRunId: 'f1' }),
  };
}

const unreachable =
  (kind: 'transient' | 'permanent') => (): Promise<BoardJob[]> =>
    new Promise((resolve) => {
      const t = new FetchTally();
      const err =
        kind === 'transient'
          ? Object.assign(new Error('getaddrinfo EAI_AGAIN x'), {
              code: 'EAI_AGAIN',
            })
          : new Error('POST -> 401');
      t.failedWith(err);
      t.failedWith(err);
      t.assertReachable('jooble');
      resolve([]);
    });
const OUTAGE = 'jooble: all 2 requests failed (EAI_AGAIN ×2)';
const REFUSED = 'jooble: all 2 requests failed (HTTP 401 ×2)';
const ONE_JOB = [
  {
    company: { name: 'Acme' },
    job: { externalId: 'e1' },
  } as unknown as BoardJob,
];

let logged: string[];
beforeEach(() => {
  logged = [];
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});
afterEach(() => jest.restoreAllMocks());

describe('crawlBoard: one FAILED run per job, recorded when the job ends (D1)', () => {
  it('a transient failure before the last attempt is rethrown for a retry, and nothing is recorded', async () => {
    const api = fakeApi();

    const run = crawlBoard('jooble', api, unreachable('transient'), {
      made: 0,
      max: 4,
    });

    await expect(run).rejects.toThrow(OUTAGE);
    await expect(run).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(api.recordBoardFailure).not.toHaveBeenCalled();
    expect(api.ingestBoardJobs).not.toHaveBeenCalled();
    expect(logged.join('\n')).toContain(
      'retrying with backoff; recorded only if the job ends failed',
    );
  });

  it('a transient failure on the last attempt records one FAILED run and is rethrown as a plain Error', async () => {
    const api = fakeApi();

    const run = crawlBoard('jooble', api, unreachable('transient'), {
      made: 3,
      max: 4,
    });

    await expect(run).rejects.toThrow(OUTAGE);
    await expect(run).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(api.recordBoardFailure).toHaveBeenCalledTimes(1);
    expect(api.recordBoardFailure).toHaveBeenCalledWith('jooble', OUTAGE);
  });

  it('four failed attempts of one job record exactly one FAILED run, on the fourth', async () => {
    const api = fakeApi();

    for (let made = 0; made < 4; made++) {
      await expect(
        crawlBoard('jooble', api, unreachable('transient'), { made, max: 4 }),
      ).rejects.toThrow(OUTAGE);
      expect(api.recordBoardFailure).toHaveBeenCalledTimes(made === 3 ? 1 : 0);
    }
  });

  it('a transient failure followed by a success records no FAILED run and ingests once', async () => {
    const api = fakeApi();

    await expect(
      crawlBoard('jooble', api, unreachable('transient'), { made: 0, max: 4 }),
    ).rejects.toThrow(OUTAGE);
    await crawlBoard('jooble', api, () => Promise.resolve(ONE_JOB), {
      made: 1,
      max: 4,
    });

    expect(api.recordBoardFailure).not.toHaveBeenCalled();
    expect(api.ingestBoardJobs).toHaveBeenCalledTimes(1);
    expect(api.ingestBoardJobs).toHaveBeenCalledWith('jooble', ONE_JOB);
  });

  it('a permanent failure on the first attempt records one FAILED run and stops retries (UnrecoverableError)', async () => {
    const api = fakeApi();

    await expect(
      crawlBoard('jooble', api, unreachable('permanent'), { made: 0, max: 4 }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(api.recordBoardFailure).toHaveBeenCalledTimes(1);
    expect(api.recordBoardFailure).toHaveBeenCalledWith('jooble', REFUSED);
    expect(api.ingestBoardJobs).not.toHaveBeenCalled();
  });

  it('a job with no attempts set has one attempt, so its first failure is recorded', async () => {
    const api = fakeApi();

    await expect(
      crawlBoard('jooble', api, unreachable('transient')),
    ).rejects.toThrow(OUTAGE);
    expect(api.recordBoardFailure).toHaveBeenCalledTimes(1);
  });

  it('a 429 on every request is transient: retried, not ended, before the last attempt', async () => {
    const api = fakeApi();
    const limited = (): Promise<BoardJob[]> =>
      new Promise((resolve) => {
        const t = new FetchTally();
        t.failedWith(new Error('POST -> 429'));
        t.assertReachable('jooble');
        resolve([]);
      });

    const run = crawlBoard('jooble', api, limited, { made: 0, max: 4 });

    await expect(run).rejects.toThrow(
      'jooble: all 1 requests failed (HTTP 429 ×1)',
    );
    await expect(run).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(api.recordBoardFailure).not.toHaveBeenCalled();
  });
});

describe('crawlBoard: when recording the failure fails (F4)', () => {
  const apiDown = new Error(
    'API POST /internal/boards/failed -> 503: unavailable',
  );

  it('a permanent failure is still UnrecoverableError, with the classified reason, and the log says it was not saved', async () => {
    const api = fakeApi();
    api.recordBoardFailure.mockRejectedValue(apiDown);

    const run = crawlBoard('jooble', api, unreachable('permanent'), {
      made: 0,
      max: 4,
    });

    await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(run).rejects.toThrow(REFUSED);
    expect(api.recordBoardFailure).toHaveBeenCalledTimes(1);
    expect(logged.join('\n')).toContain(
      'the FAILED run could NOT be saved (HTTP 503)',
    );
  });

  it('a transient failure on the last attempt is still a plain Error with the classified reason', async () => {
    const api = fakeApi();
    api.recordBoardFailure.mockRejectedValue(apiDown);

    const run = crawlBoard('jooble', api, unreachable('transient'), {
      made: 3,
      max: 4,
    });

    await expect(run).rejects.toThrow(OUTAGE);
    await expect(run).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(logged.join('\n')).toContain(
      'the FAILED run could NOT be saved (HTTP 503)',
    );
    expect(logged.join('\n')).not.toContain('recorded FAILED');
  });

  it('an API that cannot be reached at all is named by its code only', async () => {
    const api = fakeApi();
    api.recordBoardFailure.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
      }),
    );

    await expect(
      crawlBoard('jooble', api, unreachable('permanent')),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(logged.join('\n')).toContain(
      'the FAILED run could NOT be saved (ECONNREFUSED)',
    );
  });
});

describe('crawlBoard: a source that is not configured (D2)', () => {
  it('is skipped: neither ingested nor recorded, and the log says why', async () => {
    const api = fakeApi();
    const noKey = (): Promise<BoardJob[]> =>
      Promise.reject(new SourceNotConfiguredError('jooble', 'JOOBLE_API_KEY'));

    await expect(
      crawlBoard('jooble', api, noKey, { made: 0, max: 4 }),
    ).resolves.toEqual({
      skipped: 'not-configured',
      board: 'jooble',
    });
    expect(api.ingestBoardJobs).not.toHaveBeenCalled();
    expect(api.recordBoardFailure).not.toHaveBeenCalled();
    expect(logged.join('\n')).toContain(
      'jooble: skipped — jooble: not configured (JOOBLE_API_KEY not set)',
    );
  });
});

describe('crawlBoard: answers and classification', () => {
  it('classifies an error thrown by an adapter without a tally, keeping URLs out of the record', async () => {
    const api = fakeApi();
    const failing = (): Promise<BoardJob[]> =>
      Promise.reject(
        new Error('GET https://api.adzuna.test/jobs?app_key=SECRET -> 503'),
      );

    const run = crawlBoard('adzuna', api, failing);

    await expect(run).rejects.toThrow('adzuna: request failed (HTTP 503)');
    expect(api.recordBoardFailure).toHaveBeenCalledWith(
      'adzuna',
      'adzuna: request failed (HTTP 503)',
    );
    expect(JSON.stringify(api.recordBoardFailure.mock.calls)).not.toContain(
      'SECRET',
    );
    expect(logged.join('\n')).not.toContain('SECRET');
  });

  it('ingests a reachable source with no jobs as a genuine zero, not a failure', async () => {
    const api = fakeApi();

    await crawlBoard('freehire', api, () => Promise.resolve([]));

    expect(api.ingestBoardJobs).toHaveBeenCalledWith('freehire', []);
    expect(api.recordBoardFailure).not.toHaveBeenCalled();
  });

  it('passes through the SourceUnreachableError message unchanged', async () => {
    const api = fakeApi();
    const fetcher = (): Promise<BoardJob[]> =>
      Promise.reject(
        new SourceUnreachableError(
          'freehire',
          'transient',
          6,
          'fetch failed ×6',
        ),
      );

    await expect(crawlBoard('freehire', api, fetcher)).rejects.toThrow(
      'freehire: all 6 requests failed (fetch failed ×6)',
    );
  });
});

describe('the crawl-board queue', () => {
  it('has a fetcher for exactly the boards in BOARD_SOURCES', () => {
    expect(Object.keys(BOARDS).sort()).toEqual([...BOARD_SOURCES].sort());
  });

  it("boardJobProcessor reads the attempt from BullMQ's job: its last attempt records the failure", async () => {
    const api = fakeApi();
    const fetchers = { ...BOARDS, jooble: unreachable('transient') };
    const job = (attemptsMade: number, attempts?: number) =>
      ({
        data: { board: 'jooble' },
        attemptsMade,
        opts: { attempts },
      }) as unknown as Job<CrawlBoardJobData>;

    await expect(boardJobProcessor(api, fetchers)(job(2, 4))).rejects.toThrow(
      OUTAGE,
    );
    expect(api.recordBoardFailure).not.toHaveBeenCalled();
    await expect(boardJobProcessor(api, fetchers)(job(3, 4))).rejects.toThrow(
      OUTAGE,
    );
    expect(api.recordBoardFailure).toHaveBeenCalledTimes(1);
    await expect(boardJobProcessor(api, fetchers)(job(0))).rejects.toThrow(
      OUTAGE,
    );
    expect(api.recordBoardFailure).toHaveBeenCalledTimes(2);
  });
});
