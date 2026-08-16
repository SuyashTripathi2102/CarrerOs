/**
 * Diagnostic: what is actually in the crawl-board queue?
 *
 * A scheduler whose `next` sits in the past has a missed occurrence. This shows
 * whether the job is delayed, waiting, stuck active, or failed — the difference
 * between "will fire on wake" and "silently lost".
 */
import { Queue } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';

async function main(): Promise<void> {
  const connection = createRedisConnection();
  const queue = new Queue(QueueNames.CRAWL_BOARD, { connection });
  try {
    console.log(`now = ${new Date().toISOString()}`);
    const counts = await queue.getJobCounts(
      'wait', 'active', 'delayed', 'completed', 'failed', 'paused',
    );
    console.log('counts:', JSON.stringify(counts));
    console.log(`paused: ${await queue.isPaused()}`);

    for (const state of ['delayed', 'wait', 'active'] as const) {
      const jobs = await queue.getJobs([state], 0, 20);
      for (const j of jobs) {
        const board = (j.data as { board?: string })?.board ?? '?';
        console.log(
          `  ${state.padEnd(8)} id=${String(j.id).padEnd(24)} board=${board.padEnd(10)} ` +
            `delay=${j.opts.delay ?? 0} ts=${new Date(j.timestamp).toISOString()}`,
        );
      }
    }

    const failed = await queue.getJobs(['failed'], 0, 10);
    for (const j of failed) {
      const board = (j.data as { board?: string })?.board ?? '?';
      console.log(`  FAILED   board=${board} reason=${String(j.failedReason).slice(0, 160)}`);
    }

    const completed = await queue.getJobs(['completed'], 0, 10);
    for (const j of completed) {
      const board = (j.data as { board?: string })?.board ?? '?';
      const fin = j.finishedOn ? new Date(j.finishedOn).toISOString() : '?';
      console.log(`  done     board=${board.padEnd(10)} finished=${fin}`);
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
