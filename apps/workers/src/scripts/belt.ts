/**
 * Pause / resume the evaluation belt without touching discovery.
 *
 * Written 2026-08-15 during the decisionVersion split-brain incident: the belt
 * was re-judging the same 89 jobs every tick at ~$1.29/hour for zero new
 * decisions, and stopping it by killing the workers would also have stopped
 * discovery, embedding and notifications.
 *
 * Pausing is a Redis-side flag on the queue itself, so it survives an API or
 * worker restart and does not depend on the budget guard. A paused queue still
 * ACCEPTS jobs from the repeatable scheduler — they simply queue up rather than
 * running — so nothing is lost, and `resume` drains whatever accumulated.
 *
 *   npx tsx src/scripts/belt.ts pause
 *   npx tsx src/scripts/belt.ts resume
 *   npx tsx src/scripts/belt.ts status
 */
import { Queue } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';

async function main(): Promise<void> {
  const action = process.argv[2];
  if (!action || !['pause', 'resume', 'status'].includes(action)) {
    console.error('usage: belt.ts <pause|resume|status>');
    process.exit(1);
  }

  // Held separately so it can be quit explicitly: `queue.close()` leaves an
  // ioredis client created with `maxRetriesPerRequest: null` reconnecting
  // forever, and the script hangs after printing its answer.
  const connection = createRedisConnection();
  const queue = new Queue(QueueNames.EVALUATE_MATCHES, { connection });
  try {
    if (action === 'pause') await queue.pause();
    if (action === 'resume') await queue.resume();

    const paused = await queue.isPaused();
    const counts = await queue.getJobCounts('wait', 'active', 'delayed');
    console.log(
      `[belt] ${paused ? 'PAUSED' : 'RUNNING'} — waiting=${counts.wait} active=${counts.active} delayed=${counts.delayed}`,
    );
  } finally {
    await queue.close();
    await connection.quit();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
