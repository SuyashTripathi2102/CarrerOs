import { Worker, Job } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';
import { ApiClient } from '../api-client';
import { fetchRemoteOkJobs } from '../adapters/remoteok';

export interface CrawlBoardJobData {
  board: 'remoteok'; // future: 'weworkremotely' | 'hn-hiring' | ...
}

export function startCrawlBoardWorker(api: ApiClient): Worker<CrawlBoardJobData> {
  return new Worker<CrawlBoardJobData>(
    QueueNames.CRAWL_BOARD,
    async (job: Job<CrawlBoardJobData>) => {
      if (job.data.board !== 'remoteok') throw new Error(`Unknown board ${job.data.board}`);

      const entries = await fetchRemoteOkJobs();
      const result = await api.ingestBoardJobs('remoteok', entries);
      console.log(
        `[crawl-board] remoteok: found=${result.found} new=${result.created} (companies auto-discovered via flywheel)`,
      );
      return result;
    },
    { connection: createRedisConnection(), concurrency: 1 },
  );
}
