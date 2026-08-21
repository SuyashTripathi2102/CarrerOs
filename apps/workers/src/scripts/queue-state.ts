/** Report BullMQ counts for the pipeline queues. Read-only. */
import 'dotenv/config';
import { Queue } from 'bullmq';
import { createRedisConnection } from '../queues/connection';

async function main(): Promise<void> {
  const c = createRedisConnection();
  try {
    for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['embed-jobs', 'evaluate-matches']) {
      const q = new Queue(name, { connection: c });
      const counts = await q.getJobCounts('wait', 'active', 'completed', 'failed', 'delayed');
      console.log(name.padEnd(20), JSON.stringify(counts));
      for (const f of await q.getJobs(['failed'], 0, 1)) {
        console.log('   last failure:', (f.failedReason ?? '').slice(0, 160));
      }
      await q.close();
    }
  } finally {
    c.quit();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
