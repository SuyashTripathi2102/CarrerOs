/**
 * Manually enqueue a board crawl — the same job the scheduler fires.
 *
 * Ingest is idempotent (fingerprint dedup + externalId upsert), so running a
 * board early does not double-count: the scheduled run that follows simply
 * finds almost nothing new.
 *
 *   npx tsx src/scripts/trigger-board.ts freehire
 */
import { Queue } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';

const BOARDS = ['remoteok', 'hn-hiring', 'adzuna', 'jooble', 'freehire'] as const;

async function main(): Promise<void> {
  const board = process.argv[2];
  if (!board || !BOARDS.includes(board as (typeof BOARDS)[number])) {
    console.error(`usage: trigger-board.ts <${BOARDS.join('|')}>`);
    process.exit(1);
  }

  const connection = createRedisConnection();
  const queue = new Queue(QueueNames.CRAWL_BOARD, { connection });
  try {
    const job = await queue.add(
      'manual',
      { board },
      { attempts: 1, removeOnComplete: true, removeOnFail: false },
    );
    console.log(`[trigger] queued ${board} (job ${job.id}) — watch the worker log`);
  } finally {
    await queue.close();
    await connection.quit();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
