import 'dotenv/config';
import { ApiClient } from './api-client';
import { startCrawlCompanyWorker } from './processors/crawl-company.processor';
import { startCrawlBoardWorker } from './processors/crawl-board.processor';
import { ensureRefreshSchedule, startRefreshAllWorker } from './processors/refresh-all.processor';

async function main() {
  const api = new ApiClient();

  const workers = [
    startRefreshAllWorker(api),
    startCrawlCompanyWorker(api),
    startCrawlBoardWorker(api),
  ];
  await ensureRefreshSchedule();

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
