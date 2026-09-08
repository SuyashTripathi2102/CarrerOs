import { Queue } from 'bullmq';
import { QueueNames } from './queues/names';
import { createRedisConnection } from './queues/connection';
import { scanQueue } from './queue-health';

/**
 * Periodic wedge check across every queue.
 *
 * REPORTING ONLY. It never restarts, clears, retries or mutates anything — see
 * queue-health.ts for why. A wedged queue stays wedged until a human looks at
 * it, which is the point: career-extract sat wedged for five days precisely
 * because nothing said so out loud.
 *
 * Runs on a plain interval, NOT as a BullMQ job. A scheduled job that watches
 * for wedged schedules can itself wedge, and would then be silent about its own
 * silence.
 */
const EVERY_MS = 15 * 60 * 1000;

export function startQueueHealthCheck(): NodeJS.Timeout {
  const names = Object.values(QueueNames);

  const tick = async () => {
    const conn = createRedisConnection();
    try {
      const wedged: string[] = [];
      for (const name of names) {
        const q = new Queue(name, { connection: conn });
        try {
          const r = await scanQueue(name, q);
          if (r.wedged) wedged.push(r.message);
        } catch {
          // A queue that cannot be inspected is not evidence of a wedge.
        } finally {
          await q.close().catch(() => undefined);
        }
      }
      // Silent when healthy. Only a real wedge is worth a line, or the signal
      // drowns in noise exactly like the 18,189 lock errors nobody read.
      for (const m of wedged) console.warn(m);
    } finally {
      await conn.quit().catch(() => undefined);
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), EVERY_MS);
  timer.unref?.();
  console.log(`[queue-health] wedge check: every ${EVERY_MS / 60000}m over ${names.length} queues`);
  return timer;
}
