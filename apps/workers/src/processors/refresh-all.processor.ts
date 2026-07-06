import { Worker, Queue } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';
import { ApiClient } from '../api-client';
import type { CrawlCompanyJobData } from './crawl-company.processor';
import type { CrawlBoardJobData } from './crawl-board.processor';

/**
 * The fan-out step: one "refresh-all" tick (24h repeatable, or manual via
 * POST /crawl/trigger) becomes one crawl-company job per crawlable company
 * plus one job per aggregate board. Per-company failures retry independently
 * and never block the rest.
 */
export function startRefreshAllWorker(api: ApiClient): Worker {
  // removeOnComplete/Fail = true is deliberate: we reuse static jobIds
  // (crawl-<companyId>) to dedupe *concurrent* runs, and BullMQ silently
  // ignores an add whose jobId still exists in ANY state — keeping finished
  // jobs around would turn every future 24h tick into a no-op. Crawl history
  // lives in Postgres (crawl_runs), not Redis.
  const companyQueue = new Queue<CrawlCompanyJobData>(QueueNames.CRAWL_COMPANY, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  const boardQueue = new Queue<CrawlBoardJobData>(QueueNames.CRAWL_BOARD, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  return new Worker(
    QueueNames.REFRESH_ALL,
    async () => {
      const companies = await api.getCompaniesDue();

      await companyQueue.addBulk(
        companies.map((c) => ({
          name: c.name,
          data: {
            companyId: c.id,
            companyName: c.name,
            atsProvider: c.atsProvider,
            atsIdentifier: c.atsIdentifier,
          },
          // If a previous run's job for this company is still queued, skip the dupe.
          opts: { jobId: `crawl-${c.id}` },
        })),
      );
      await boardQueue.add('remoteok', { board: 'remoteok' }, { jobId: 'board-remoteok' });

      console.log(`[refresh-all] fanned out ${companies.length} companies + 1 board`);
      return { companies: companies.length };
    },
    { connection: createRedisConnection() },
  );
}

/** Ensure the 24h repeatable tick exists (idempotent upsert by key). */
export async function ensureRefreshSchedule(): Promise<void> {
  const queue = new Queue(QueueNames.REFRESH_ALL, { connection: createRedisConnection() });
  await queue.upsertJobScheduler(
    'refresh-all-24h',
    { every: 24 * 60 * 60 * 1000 },
    { name: 'scheduled' },
  );
  await queue.close();
  console.log('[scheduler] refresh-all repeats every 24h');
}
