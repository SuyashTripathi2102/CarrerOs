import 'dotenv/config';
import { installProcessGuard } from './process-guard';
import { startQueueHealthCheck } from './queue-health.runner';
import { ApiClient } from './api-client';
import { startCrawlCompanyWorker } from './processors/crawl-company.processor';
import { ensureBoardSchedules, startCrawlBoardWorker } from './processors/crawl-board.processor';
import {
  startDiscoverCompanyWorker,
  startDiscoveryFanoutWorker,
} from './processors/discover-company.processor';
import { startSeedImportWorker } from './processors/seed-import.processor';
import { ensureRefreshSchedule, startRefreshAllWorker } from './processors/refresh-all.processor';
import {
  ensureEvaluateMatchesSchedule,
  startEvaluateMatchesWorker,
} from './processors/evaluate-matches.processor';
import {
  ensureEmbeddingSweepSchedule,
  startEmbeddingSweepWorker,
} from './processors/embedding-sweep.processor';
import {
  ensureDailyBriefSchedule,
  startDailyBriefWorker,
} from './processors/daily-brief.processor';
import {
  ensurePlacesDiscoverySchedule,
  startPlacesDiscoveryWorker,
} from './processors/places-discovery.processor';
import {
  ensureCareerExtractSchedule,
  ensureReplayExtractSchedule,
  ensureRenderExtractSchedule,
  startCareerExtractWorker,
  startReplayExtractWorker,
  startRenderExtractWorker,
} from './processors/extract-career-pages.processor';

async function main() {
  // One malformed response from a third-party board must not be able to take
  // the crawls and the evaluation belt down with it.
  installProcessGuard();

  // Reporting only: surfaces a repeatable whose next fire is overdue while a
  // worker is attached and work sits unclaimed. career-extract sat in exactly
  // that state for five days with failed:0 and no error anywhere.
  startQueueHealthCheck();
  const api = new ApiClient();

  const workers = [
    startRefreshAllWorker(api),
    startCrawlCompanyWorker(api),
    startCrawlBoardWorker(api),
    startDiscoveryFanoutWorker(api),
    startDiscoverCompanyWorker(api),
    startSeedImportWorker(api),
    startDailyBriefWorker(api),
    startPlacesDiscoveryWorker(api),
    startCareerExtractWorker(api),
    startReplayExtractWorker(api),
    startRenderExtractWorker(api),
    startEvaluateMatchesWorker(api),
    startEmbeddingSweepWorker(api),
  ];
  await ensureRefreshSchedule();
  await ensureEvaluateMatchesSchedule();
  await ensureDailyBriefSchedule();
  await ensureEmbeddingSweepSchedule();
  await ensurePlacesDiscoverySchedule();
  await ensureBoardSchedules();
  await ensureCareerExtractSchedule();
  await ensureReplayExtractSchedule();
  await ensureRenderExtractSchedule();

  console.log(`CareerOS workers started (${workers.length} processors listening).`);

  const shutdown = async () => {
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Workers failed to start:', err);
  process.exit(1);
});
