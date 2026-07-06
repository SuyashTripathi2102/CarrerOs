import 'dotenv/config';
import { startCrawlCompanyWorker } from './processors/crawl-company.processor';

const workers = [startCrawlCompanyWorker()];

console.log(`JobIntel workers started (${workers.length} processor[s] listening).`);

process.on('SIGTERM', async () => {
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});
