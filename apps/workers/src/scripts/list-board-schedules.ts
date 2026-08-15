/**
 * List the registered board crawl schedules straight from Redis.
 *
 * A `[scheduler] ...` log line proves the code ran, not that the repeatable
 * exists — FreeHire was in the dispatch map for two days while nothing ever
 * triggered it. This reads the queue itself.
 *
 *   npx tsx src/scripts/list-board-schedules.ts
 */
import { Queue } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';

async function main(): Promise<void> {
  const connection = createRedisConnection();
  const queue = new Queue(QueueNames.CRAWL_BOARD, { connection });
  try {
    const schedulers = await queue.getJobSchedulers();
    if (schedulers.length === 0) {
      console.log('[board-schedules] NONE registered');
      return;
    }
    for (const s of schedulers) {
      const when = s.next ? new Date(s.next).toISOString() : '?';
      console.log(`  ${String(s.key).padEnd(22)} ${String(s.pattern ?? s.every).padEnd(14)} next=${when}`);
    }
  } finally {
    await queue.close();
    await connection.quit();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
