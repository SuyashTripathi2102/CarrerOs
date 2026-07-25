import { Queue, Worker, Job } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';
import { ApiClient } from '../api-client';
import { fetchRemoteOkJobs } from '../adapters/remoteok';
import { fetchHnWhoIsHiring } from '../adapters/hn-whoishiring';
import { fetchAdzunaJobs } from '../adapters/adzuna';
import { fetchJoobleJobs } from '../adapters/jooble';

export interface CrawlBoardJobData {
  board: 'remoteok' | 'hn-hiring' | 'adzuna' | 'jooble';
}

const BOARDS = {
  remoteok: fetchRemoteOkJobs,
  'hn-hiring': fetchHnWhoIsHiring,
  adzuna: fetchAdzunaJobs,
  jooble: fetchJoobleJobs,
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
    { pattern: '0 2 * * *' }, // 02:00 UTC = 07:30 IST
    { name: 'scheduled', data: { board: 'adzuna' }, opts: { attempts: 2, removeOnComplete: true, removeOnFail: true } },
  );
  // Jooble India dev jobs — daily, offset from Adzuna (500 req/day budget).
  await queue.upsertJobScheduler(
    'jooble-daily',
    { pattern: '30 2 * * *' }, // 02:30 UTC = 08:00 IST
    { name: 'scheduled', data: { board: 'jooble' }, opts: { attempts: 2, removeOnComplete: true, removeOnFail: true } },
  );
  await queue.close();
  console.log('[scheduler] hn: weekly · adzuna: daily 07:30 IST · jooble: daily 08:00 IST');
}
