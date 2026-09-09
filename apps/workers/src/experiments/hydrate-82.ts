/**
 * ONE-SHOT CONTROLLED EXPERIMENT — hydrate exactly the known career-page cohort.
 *
 *   npx tsx src/experiments/hydrate-82.ts            # dry run, writes nothing
 *   npx tsx src/experiments/hydrate-82.ts --commit   # writes recovered bodies
 *
 * DRY RUN IS THE DEFAULT and --commit must be typed by a human. This is not
 * scheduled, is not registered anywhere, and is meant to be run once, watched.
 *
 * WHY THIS COHORT. 82 career-page jobs sit at INSUFFICIENT_EVIDENCE, each with
 * its own detail URL that nothing ever fetched. A read-only probe on 2026-09-09
 * predicted 77 of them would yield a real description over ordinary HTTP,
 * including 28 of 29 software roles. That prediction is the thing being tested.
 *
 * WHAT HAPPENS AFTER, and deliberately NOT here: repairDescriptions clears the
 * embedding so the vector rebuilds, and the evidence-invalidation clause then
 * re-opens the decision on its own. This script judges nothing and must not.
 * The APPLY/CONSIDER/SKIP distribution is measured afterwards, from the belt.
 *
 * Scope guard: it targets jobs by id, taken from a query it prints. It does not
 * call hydrationDue, so it cannot wander into the wider corpus.
 */
import { ApiClient } from '../api-client';
import { fetchHtmlV4 } from '../processors/extract-career-pages.processor';
import { decideHydration } from '../adapters/detail-hydration';

const COMMIT = process.argv.includes('--commit');
const FETCH_TIMEOUT_MS = 12_000;
const PACE_MS = 400;

/**
 * The cohort, defined exactly. Run this against the database and feed the rows
 * in as EXPERIMENT_JOBS below, or pipe them via stdin — deliberately not
 * executed from here, so the set being changed is reviewable before anything
 * is fetched.
 *
 *   SELECT j.id, j."externalId", j.source, j.url,
 *          COALESCE(j.description,'') AS description
 *   FROM job_matches m
 *   JOIN jobs j ON j.id = m."jobId"
 *   WHERE j.source LIKE 'career-%'
 *     AND m."verdictCode" = 'INSUFFICIENT_EVIDENCE';
 */
interface CohortJob {
  id: string;
  externalId: string;
  source: string;
  url: string;
  description: string;
}

async function readCohort(): Promise<CohortJob[]> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    throw new Error(
      'No cohort on stdin. Pipe the rows from the query in this file, e.g.\n' +
        '  psql ... -t -A -c "<query> ... json_agg" | npx tsx src/experiments/hydrate-82.ts',
    );
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Cohort is empty.');
  return parsed as CohortJob[];
}

async function main() {
  const cohort = await readCohort();
  console.log(`cohort: ${cohort.length} job(s) — mode: ${COMMIT ? 'COMMIT' : 'DRY RUN (no writes)'}`);

  const api = new ApiClient();
  const writes = new Map<string, { externalId: string; description: string; descriptionSource: string }[]>();
  let fetched = 0;
  let failed = 0;
  let recovered = 0;
  const kept: Record<string, number> = {};

  for (const job of cohort) {
    const html = await fetchHtmlV4(job.url, FETCH_TIMEOUT_MS);
    if (html === null) failed++;
    else fetched++;

    const d = decideHydration({ description: job.description, descriptionSource: null }, html);
    if (d.action === 'WRITE') {
      recovered++;
      const list = writes.get(job.source) ?? [];
      list.push({
        externalId: job.externalId,
        description: d.description,
        descriptionSource: d.descriptionSource,
      });
      writes.set(job.source, list);
      console.log(`  RECOVERED ${String(d.description.length).padStart(6)}ch  ${job.url}`);
    } else {
      const bucket = d.reason.split('—')[0].trim();
      kept[bucket] = (kept[bucket] ?? 0) + 1;
      console.log(`  KEPT                 ${job.url}  (${d.reason})`);
    }
    await new Promise((r) => setTimeout(r, PACE_MS));
  }

  console.log(`\n=== FUNNEL ===`);
  console.log(`  attempted        ${cohort.length}`);
  console.log(`  fetched          ${fetched}`);
  console.log(`  fetch failed     ${failed}`);
  console.log(`  body recovered   ${recovered}`);
  for (const [reason, n] of Object.entries(kept)) console.log(`  kept: ${reason} — ${n}`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing written. Re-run with --commit to apply ${recovered} description(s).`);
    return;
  }

  for (const [source, updates] of writes) {
    const res = await api.repairDescriptions(source, updates);
    console.log(`  wrote ${res.changed}/${updates.length} for source=${source}`);
  }
  console.log(
    `\nWritten. The vectors rebuild on their own (repairDescriptions clears them)\n` +
      `and the decisions re-open on their own (evidence-invalidation clause).\n` +
      `Measure the APPLY/CONSIDER/SKIP distribution AFTER the belt has run — this\n` +
      `script judged nothing.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
