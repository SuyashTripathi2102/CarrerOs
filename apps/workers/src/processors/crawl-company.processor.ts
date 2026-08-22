import { Worker, Job } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';
import { ApiClient } from '../api-client';
import { AtsAdapter } from '../adapters/types';
import { greenhouseAdapter } from '../adapters/greenhouse';
import { leverAdapter } from '../adapters/lever';
import { ashbyAdapter } from '../adapters/ashby';
import { workableAdapter } from '../adapters/workable';
import { smartrecruitersAdapter } from '../adapters/smartrecruiters';
import { recruiteeAdapter } from '../adapters/recruitee';
import { breezyAdapter } from '../adapters/breezy';
import { kekaAdapter } from '../adapters/keka';
import { workdayAdapter } from '../adapters/workday';

export interface CrawlCompanyJobData {
  companyId: string;
  companyName: string;
  atsProvider: string;
  atsIdentifier: string;
}

// Keep in sync with CRAWLABLE_PROVIDERS in packages/shared/src/ats.ts —
// that list gates which companies the API hands out for crawling.
const ADAPTERS: Record<string, AtsAdapter> = {
  GREENHOUSE: greenhouseAdapter,
  LEVER: leverAdapter,
  ASHBY: ashbyAdapter,
  WORKABLE: workableAdapter,
  SMARTRECRUITERS: smartrecruitersAdapter,
  RECRUITEE: recruiteeAdapter,
  BREEZY: breezyAdapter,
  KEKA: kekaAdapter,
  // WORKDAY speaks the CXS JSON API directly — no scraper needed. The adapter
  // shipped 2026-08-20 and passed a nine-check canary, but was never listed
  // here, so eight boards found by the Bengaluru sweep sat uncrawlable behind a
  // component that already worked. It reports board completeness via
  // fetchBoard(), so a truncated walk retires nothing.
  WORKDAY: workdayAdapter,
  // DARWINBOX: public unauthenticated JSON API (verified 2026-08-21) — 20
  // boards in the Bengaluru universe, the largest remaining gap. No adapter yet.
};

/**
 * Exported so a test can assert this map and CRAWLABLE_PROVIDERS agree. Drift
 * between them is silent in one direction and has cost twice — see
 * adapter-registry-sync.spec.ts.
 */
export const CRAWLABLE_ADAPTER_NAMES = Object.keys(ADAPTERS);

export function startCrawlCompanyWorker(api: ApiClient): Worker<CrawlCompanyJobData> {
  return new Worker<CrawlCompanyJobData>(
    QueueNames.CRAWL_COMPANY,
    async (job: Job<CrawlCompanyJobData>) => {
      const { companyId, companyName, atsProvider, atsIdentifier } = job.data;
      const adapter = ADAPTERS[atsProvider];
      if (!adapter) throw new Error(`No adapter for ATS provider ${atsProvider}`);

      // An adapter that can walk off the end of a board reports whether it saw
      // all of it. One that cannot paginate always sees the whole board, so the
      // absence of fetchBoard is a genuine "complete", not an unknown.
      const board = adapter.fetchBoard
        ? await adapter.fetchBoard(atsIdentifier)
        : { jobs: await adapter.fetchJobs(atsIdentifier), complete: true as const };
      if (!board.complete) {
        console.warn(
          `[crawl-company] ${companyName}: PARTIAL board (${board.reason ?? 'unknown'}) — ` +
            `ingesting ${board.jobs.length} jobs, retiring nothing`,
        );
      }
      const result = await api.syncCompanyJobs(
        companyId,
        adapter.source,
        board.jobs,
        board.complete,
      );
      console.log(
        `[crawl-company] ${companyName}: found=${result.found} new=${result.created} removed=${result.removed}`,
      );
      return result;
    },
    {
      connection: createRedisConnection(),
      // Parallel companies, but gentle on any single ATS host. Tuned down via
      // env on small boxes (prod: 2 on the 1-vCPU droplet).
      concurrency: Number(process.env.CRAWL_CONCURRENCY ?? 5),
    },
  );
}
