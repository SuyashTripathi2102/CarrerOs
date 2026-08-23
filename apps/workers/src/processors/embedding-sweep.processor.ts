import { Worker, Queue } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';
import { ApiClient } from '../api-client';

/**
 * The embedding sweeper.
 *
 * `enqueueEmbeddings` is the only producer of embed work and it runs exactly
 * once, at ingest. Nothing ran behind it, so an id lost between ingest and
 * embed was lost permanently — the job stayed ACTIVE, looked healthy in every
 * count, and could never be retrieved because the candidate query INNER JOINs
 * `job_embeddings`.
 *
 * Measured 2026-08-23: 1,673 stranded ACTIVE jobs, 79 of them stranded inside
 * two hours by embed batches that failed and were discarded, while the queue
 * read active:0 waiting:0 failed:0 — clean. A recurrence of the same leak
 * repaired by hand in August and wrongly closed as "not an ongoing leak".
 *
 * The invariant this restores: every job requiring an embedding is eventually
 * either embedded or explicitly observable as failed — never silently
 * stranded.
 *
 * This is a RECOVERY mechanism, not a substitute for the producer. If it finds
 * work on every tick, the producer is leaking and the sweep is masking it —
 * which is why a non-zero result logs at WARN on both sides.
 */
export function startEmbeddingSweepWorker(api: ApiClient): Worker {
  return new Worker(
    QueueNames.EMBEDDING_SWEEP,
    async () => {
      const res = await api.reconcileEmbeddings();
      if (res.stranded > 0) {
        console.warn(
          `[embedding-sweep] ${res.stranded} stranded — re-enqueued ${res.enqueued}`,
        );
      }
      return res;
    },
    {
      connection: createRedisConnection(),
      // One at a time: overlapping sweeps would enqueue the same ids twice.
      concurrency: 1,
    },
  );
}

/**
 * Idempotent scheduler. 30 minutes: the sweep costs one indexed anti-join and
 * returns immediately when healthy, and nothing is urgent — a stranded job has
 * already been invisible for at least the grace window by the time it
 * qualifies. Frequent enough that a lost batch is recovered the same hour.
 */
export async function ensureEmbeddingSweepSchedule(): Promise<void> {
  const queue = new Queue(QueueNames.EMBEDDING_SWEEP, { connection: createRedisConnection() });
  await queue.upsertJobScheduler(
    'embedding-sweep-30m',
    { every: 30 * 60 * 1000 },
    {
      name: 'scheduled',
      opts: {
        // No retries: the next tick re-runs exactly the same query.
        attempts: 1,
        removeOnComplete: true,
        // Kept, not discarded. Discarding failures is what hid the original
        // leak for ten hours.
        removeOnFail: 100,
      },
    },
  );
  await queue.close();
  console.log('[scheduler] embedding-sweep: 30m');
}
