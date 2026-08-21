/**
 * Re-enqueue jobs that have no embedding, from an id list.
 *
 * WHY THIS EXISTS: embeddings are enqueued exactly once, at ingest, for the ids
 * a batch reported as new. Nothing sweeps behind that. A job whose enqueue was
 * lost — worker down, Redis restarted, API killed mid-batch — is stranded
 * permanently: it stays ACTIVE, looks healthy in every count, and can never be
 * retrieved, because the candidate query INNER JOINs job_embeddings.
 *
 * Measured 2026-08-21: 1,780 unembedded ACTIVE jobs, 90 of them fresh India
 * jobs — eligible in every respect except that retrieval cannot see them. All
 * 90 landed on 2026-08-13 (the bulk backfill), none since, so this is a
 * stranded remnant and not an ongoing leak.
 *
 * ADR-2: workers never open Postgres. The id list is produced separately and
 * passed in as a file — the same shape the Workday canary uses for its cohort.
 * Embedding is idempotent per job, so re-running is safe.
 *
 *   # 1. produce the list (one job id per line)
 *   docker exec -i careeros-postgres-1 psql -U careeros -d careeros -t -A \
 *     -f scripts/unembedded-india-fresh.sql > /tmp/ids.txt
 *
 *   # 2. dry run, then enqueue
 *   npx tsx src/scripts/repair-embeddings.ts /tmp/ids.txt
 *   npx tsx src/scripts/repair-embeddings.ts /tmp/ids.txt --enqueue
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Queue } from 'bullmq';
import { createRedisConnection } from '../queues/connection';

/** Must match apps/api/src/modules/internal/internal.constants.ts. */
const EMBED_JOBS_QUEUE = 'embed-jobs';
const BATCH = 100;

async function main(): Promise<void> {
  const file = process.argv[2];
  const enqueue = process.argv.includes('--enqueue');
  if (!file) {
    console.error('usage: repair-embeddings.ts <ids-file> [--enqueue]');
    process.exit(1);
  }

  const ids = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('('));

  console.log(`${ids.length} job id(s) read from ${file}`);
  if (ids.length === 0) return;

  if (!enqueue) {
    console.log(`DRY RUN — would enqueue in ${Math.ceil(ids.length / BATCH)} batch(es).`);
    console.log(`first 3: ${ids.slice(0, 3).join(', ')}`);
    return;
  }

  const connection = createRedisConnection();
  const queue = new Queue(EMBED_JOBS_QUEUE, { connection });
  try {
    for (let i = 0; i < ids.length; i += BATCH) {
      await queue.add(
        'embed',
        { jobIds: ids.slice(i, i + BATCH) },
        {
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 5,
          backoff: { type: 'exponential', delay: 60_000 },
        },
      );
    }
    const counts = await queue.getJobCounts('wait', 'active', 'delayed');
    console.log(
      `enqueued ${ids.length} in ${Math.ceil(ids.length / BATCH)} batch(es) — ` +
        `queue now wait=${counts.wait} active=${counts.active} delayed=${counts.delayed}`,
    );
  } finally {
    await queue.close();
    connection.quit();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
