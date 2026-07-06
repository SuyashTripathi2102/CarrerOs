import { Worker, Job } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';

interface CrawlCompanyJobData {
  companyId: string;
  atsProvider: 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'unknown';
}

/**
 * Phase 4 stub: dispatches to the Greenhouse/Lever/Ashby JSON-API fetchers
 * (implemented in this worker, since they're plain HTTP+JSON) or forwards to
 * the Python scraper queue for anti-bot/browser-automation targets.
 */
export function startCrawlCompanyWorker(): Worker<CrawlCompanyJobData> {
  return new Worker<CrawlCompanyJobData>(
    QueueNames.CRAWL_COMPANY,
    async (job: Job<CrawlCompanyJobData>) => {
      console.log(`[crawl-company] received job ${job.id} for company ${job.data.companyId}`);
      // TODO Phase 4: branch on job.data.atsProvider, call the matching fetcher.
    },
    { connection: createRedisConnection() },
  );
}
