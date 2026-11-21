import { Queue, UnrecoverableError, Worker, Job } from 'bullmq';
import type { BoardJob, BoardSource } from '@careeros/shared';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';
import { ApiClient, type SyncResult } from '../api-client';
import { fetchRemoteOkJobs } from '../adapters/remoteok';
import { fetchHnWhoIsHiring } from '../adapters/hn-whoishiring';
import { fetchAdzunaJobs } from '../adapters/adzuna';
import { fetchJoobleJobs } from '../adapters/jooble';
import { fetchFreehireJobs } from '../adapters/freehire';
import {
  describeFetchError,
  SourceNotConfiguredError,
  SourceUnreachableError,
  type FetchFailureKind,
} from '../adapters/fetch-failure';

export interface CrawlBoardJobData {
  board: BoardSource;
}

type BoardFetcher = () => Promise<BoardJob[]>;
type BoardApi = Pick<ApiClient, 'ingestBoardJobs' | 'recordBoardFailure'>;

/** One fetcher for each board in BOARD_SOURCES (@careeros/shared): `satisfies` refuses a missing or an extra one. */
export const BOARDS = {
  remoteok: fetchRemoteOkJobs,
  'hn-hiring': fetchHnWhoIsHiring,
  adzuna: fetchAdzunaJobs,
  jooble: fetchJoobleJobs,
  freehire: fetchFreehireJobs,
} satisfies Record<BoardSource, BoardFetcher>;

/**
 * Retries at +5, +10 and +20 minutes. A daily crawl that fires the moment a
 * laptop wakes meets a network that is not up yet; an immediate retry fails the
 * same way, so the delay is what makes the retry useful.
 */
export const BOARD_RETRY = {
  attempts: 4,
  backoff: { type: 'exponential' as const, delay: 5 * 60_000 },
};

/** A board crawl skipped because the source is not configured: nothing fetched, ingested or recorded. */
export interface BoardSkipped {
  skipped: 'not-configured';
  board: BoardSource;
}

function classifyBoardFailure(
  board: string,
  err: unknown,
): { kind: FetchFailureKind; reason: string } {
  if (err instanceof SourceUnreachableError)
    return { kind: err.kind, reason: err.message };
  const { kind, code } = describeFetchError(err);
  return { kind, reason: `${board}: request failed (${code})` };
}

/**
 * One attempt of one board crawl job.
 *
 * - The source answered, even with no jobs: ingested. A real zero is a real zero.
 * - The source is not configured (no key): skipped and logged. Nothing is ingested or recorded,
 *   because no crawl happened.
 * - The fetch failed: one FAILED crawl run per job, not per attempt, recorded when the job ends:
 *     - a permanent failure at once, then UnrecoverableError, so BullMQ does not retry it;
 *     - a transient failure only on the job's last attempt. Earlier attempts are logged and
 *       rethrown, so BullMQ retries them, and a later success leaves no FAILED run.
 * - Recording can fail as well (the API down). That is logged, the FAILED run is NOT saved, and
 *   the fetch failure's own classification still decides whether BullMQ retries.
 *
 * The error thrown carries only the classified reason: the original message can hold a request
 * URL, and some sources put their key in it.
 */
export async function crawlBoard(
  board: BoardSource,
  api: BoardApi,
  fetcher: BoardFetcher | undefined = BOARDS[board],
  attempt: { made: number; max: number } = { made: 0, max: 1 },
): Promise<SyncResult | BoardSkipped> {
  if (!fetcher) throw new Error(`Unknown board ${board}`);

  let entries: BoardJob[];
  try {
    entries = await fetcher();
  } catch (err) {
    if (err instanceof SourceNotConfiguredError) {
      console.log(
        `[crawl-board] ${board}: skipped — ${err.message}; nothing ingested or recorded`,
      );
      return { skipped: 'not-configured', board };
    }
    const { kind, reason } = classifyBoardFailure(board, err);
    const endsJob = kind === 'permanent' || attempt.made + 1 >= attempt.max;
    let outcome = 'retrying with backoff; recorded only if the job ends failed';
    if (endsJob) {
      try {
        await api.recordBoardFailure(board, reason);
        outcome = 'recorded FAILED; not retried';
      } catch (recordErr) {
        outcome = `the FAILED run could NOT be saved (${describeFetchError(recordErr).code}); not retried`;
      }
    }
    console.log(
      `[crawl-board] ${board}: FAILED (attempt ${attempt.made + 1}/${attempt.max}) — ${reason} — ${outcome}`,
    );
    if (kind === 'permanent') throw new UnrecoverableError(reason);
    throw new Error(reason);
  }

  const result = await api.ingestBoardJobs(board, entries);
  console.log(
    `[crawl-board] ${board}: found=${result.found} new=${result.created} (companies auto-discovered via flywheel)`,
  );
  return result;
}

/** The crawl-board queue's processor: each run with the attempt numbers BullMQ gives it. */
export function boardJobProcessor(
  api: BoardApi,
  fetchers: Record<BoardSource, BoardFetcher> = BOARDS,
) {
  return (job: Job<CrawlBoardJobData>) =>
    crawlBoard(job.data.board, api, fetchers[job.data.board], {
      made: job.attemptsMade,
      max: job.opts.attempts ?? 1,
    });
}

export function startCrawlBoardWorker(
  api: ApiClient,
): Worker<CrawlBoardJobData> {
  return new Worker<CrawlBoardJobData>(
    QueueNames.CRAWL_BOARD,
    boardJobProcessor(api),
    {
      connection: createRedisConnection(),
      concurrency: 1,
    },
  );
}

/**
 * HN "Who is hiring?" is a monthly thread (1st of the month). Refresh it
 * weekly so late-added comments and edits are picked up; ingest is idempotent.
 */
export async function ensureBoardSchedules(): Promise<void> {
  const queue = new Queue(QueueNames.CRAWL_BOARD, {
    connection: createRedisConnection(),
  });
  await queue.upsertJobScheduler(
    'hn-hiring-weekly',
    { pattern: '0 5 * * 2' }, // Tuesdays 05:00 UTC
    {
      name: 'scheduled',
      data: { board: 'hn-hiring' },
      opts: { ...BOARD_RETRY, removeOnComplete: true, removeOnFail: true },
    },
  );
  // Adzuna India dev jobs — daily (India roles post every day; ingest is idempotent).
  await queue.upsertJobScheduler(
    'adzuna-daily',
    { pattern: '0 2 * * *' }, // 02:00 IST (server-local, not UTC)
    {
      name: 'scheduled',
      data: { board: 'adzuna' },
      opts: { ...BOARD_RETRY, removeOnComplete: true, removeOnFail: true },
    },
  );
  // Jooble India dev jobs — daily, offset from Adzuna (500 req/day budget).
  await queue.upsertJobScheduler(
    'jooble-daily',
    { pattern: '30 2 * * *' }, // 02:30 IST (server-local, not UTC)
    {
      name: 'scheduled',
      data: { board: 'jooble' },
      opts: { ...BOARD_RETRY, removeOnComplete: true, removeOnFail: true },
    },
  );
  /**
   * FreeHire — daily, offset behind Adzuna and Jooble.
   *
   * Registered 2026-08-15. Until then FreeHire was wired into the dispatch map
   * but nothing ever triggered it: its last crawl was 2026-08-13, presumably by
   * hand. The pagination work would have sat dormant indefinitely. Fifth
   * instance of one pattern — the system CAN do something and nothing asks it
   * to (cf. the evaluation belt, gate-refusal persistence, decisionVersion,
   * NEEDS_REVIEW).
   *
   * Daily, not 6-hourly, ON PURPOSE. FreeHire measures 67 APPLY+CONSIDER per
   * 1,000 jobs against the next-best source's 5.77, but that is from a 149-job
   * sample. One crawl per day yields one measurable delta; four overlapping
   * cycles would confound extra pages, extra frequency and normal source churn.
   * Revisit once 2-3 clean daily measurements exist.
   */
  await queue.upsertJobScheduler(
    'freehire-daily',
    { pattern: '0 3 * * *' }, // 03:00 IST — see the timezone note below
    {
      name: 'scheduled',
      data: { board: 'freehire' },
      opts: { ...BOARD_RETRY, removeOnComplete: true, removeOnFail: true },
    },
  );
  await queue.close();
  // TIMEZONE: BullMQ evaluates these patterns in SERVER-LOCAL time, not UTC.
  // The comments here read "02:00 UTC = 07:30 IST" until 2026-08-15, which was
  // wrong by 5.5 hours — verified against Redis, `0 3 * * *` scheduled
  // 2026-08-15T21:30Z, i.e. 03:00 IST. The staggering (02:00 / 02:30 / 03:00
  // IST) works as intended; only the labels were wrong.
  console.log(
    '[scheduler] hn: weekly · adzuna: daily 02:00 IST · jooble: daily 02:30 IST · freehire: daily 03:00 IST',
  );
}
