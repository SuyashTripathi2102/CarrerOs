import { Queue, Worker, Job } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';
import { ApiClient } from '../api-client';
import { fetchRemoteOkJobs } from '../adapters/remoteok';
import { fetchHnWhoIsHiring } from '../adapters/hn-whoishiring';
import { fetchAdzunaJobs } from '../adapters/adzuna';
import { fetchJoobleJobs } from '../adapters/jooble';
import { fetchFreehireJobs } from '../adapters/freehire';

export interface CrawlBoardJobData {
  board: 'remoteok' | 'hn-hiring' | 'adzuna' | 'jooble' | 'freehire';
}

const BOARDS = {
  remoteok: fetchRemoteOkJobs,
  'hn-hiring': fetchHnWhoIsHiring,
  adzuna: fetchAdzunaJobs,
  jooble: fetchJoobleJobs,
  freehire: fetchFreehireJobs,
} as const;

export function startCrawlBoardWorker(api: ApiClient): Worker<CrawlBoardJobData> {
  return new Worker<CrawlBoardJobData>(
    QueueNames.CRAWL_BOARD,
    async (job: Job<CrawlBoardJobData>) => {
      const fetcher = BOARDS[job.data.board];
      if (!fetcher) throw new Error(`Unknown board ${job.data.board}`);

      const entries = await fetcher();
      const result = await api.ingestBoardJobs(job.data.board, entries);
      console.log(
        `[crawl-board] ${job.data.board}: found=${result.found} new=${result.created} (companies auto-discovered via flywheel)`,
      );
      return result;
    },
    { connection: createRedisConnection(), concurrency: 1 },
  );
}

/**
 * HN "Who is hiring?" is a monthly thread (1st of the month). Refresh it
 * weekly so late-added comments and edits are picked up; ingest is idempotent.
 */
export async function ensureBoardSchedules(): Promise<void> {
  const queue = new Queue(QueueNames.CRAWL_BOARD, { connection: createRedisConnection() });
  await queue.upsertJobScheduler(
    'hn-hiring-weekly',
    { pattern: '0 5 * * 2' }, // Tuesdays 05:00 UTC
    { name: 'scheduled', data: { board: 'hn-hiring' }, opts: { attempts: 2, removeOnComplete: true, removeOnFail: true } },
  );
  // Adzuna India dev jobs — daily (India roles post every day; ingest is idempotent).
  await queue.upsertJobScheduler(
    'adzuna-daily',
    { pattern: '0 2 * * *' }, // 02:00 IST (server-local, not UTC)
    { name: 'scheduled', data: { board: 'adzuna' }, opts: { attempts: 2, removeOnComplete: true, removeOnFail: true } },
  );
  // Jooble India dev jobs — daily, offset from Adzuna (500 req/day budget).
  await queue.upsertJobScheduler(
    'jooble-daily',
    { pattern: '30 2 * * *' }, // 02:30 IST (server-local, not UTC)
    { name: 'scheduled', data: { board: 'jooble' }, opts: { attempts: 2, removeOnComplete: true, removeOnFail: true } },
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
    { name: 'scheduled', data: { board: 'freehire' }, opts: { attempts: 2, removeOnComplete: true, removeOnFail: true } },
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
