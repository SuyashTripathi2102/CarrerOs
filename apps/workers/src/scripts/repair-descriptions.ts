/**
 * Repair the 6,907 job descriptions that were stored empty.
 *
 * This is a DATA REPAIR, not a crawl. It re-fetches each board with the fixed
 * adapters and updates description + descriptionSource on rows that already
 * exist, through POST /internal/jobs/repair-descriptions — an endpoint that
 * cannot insert, cannot retire, and touches no other column.
 *
 * A normal re-crawl would be wrong here: syncCompanyJobs reconciles, so any
 * board returning fewer rows than the corpus holds would retire the
 * difference. Repairing descriptions must not be able to delete a job. That is
 * the Workday truncation shape exactly.
 *
 * WHY (measured 2026-08-23):
 *   lever   9,174 of 11,104 rows empty — the adapter read `descriptionPlain`
 *           while the body sat in `description`. Already-downloaded content,
 *           discarded. No extra requests needed to recover it.
 *   breezy  2,930 of 2,930 empty — the listing has no description field at
 *           all; the body comes from the posting page's schema.org JobPosting.
 *
 * The gate then refused these as NOT_DEVELOPMENT for "no coding responsibility
 * stated", so breezy measured 0.2% actionable. That number described our
 * ingestion, not the jobs.
 *
 *   npx tsx src/scripts/repair-descriptions.ts <cohort.tsv>            # dry run
 *   npx tsx src/scripts/repair-descriptions.ts <cohort.tsv> --apply
 *
 * cohort.tsv: `PROVIDER<TAB>identifier` per line.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import type { AtsAdapter } from '../adapters/types';
import { leverAdapter } from '../adapters/lever';
import { breezyAdapter } from '../adapters/breezy';
import { ApiClient } from '../api-client';

const ADAPTERS: Record<string, AtsAdapter> = { LEVER: leverAdapter, BREEZY: breezyAdapter };
const BATCH = 500;

async function main(): Promise<void> {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) {
    console.error('usage: repair-descriptions.ts <cohort.tsv> [--apply]');
    process.exit(1);
  }

  const cohort = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [provider, identifier] = l.split('\t');
      return { provider: (provider ?? '').trim(), identifier: (identifier ?? '').trim() };
    })
    .filter((r) => r.provider && r.identifier && ADAPTERS[r.provider]);

  console.log(`${cohort.length} boards | mode: ${apply ? 'APPLY (writes)' : 'DRY RUN'}\n`);

  const api = apply ? new ApiClient() : null;
  const totals = { fetched: 0, withBody: 0, missing: 0, changed: 0, unchanged: 0, notFound: 0, failed: 0 };

  for (const { provider, identifier } of cohort) {
    let jobs;
    try {
      jobs = await ADAPTERS[provider].fetchJobs(identifier);
    } catch (err) {
      totals.failed++;
      console.log(`  ${provider}/${identifier}`.padEnd(46) + `FETCH FAILED ${(err as Error).message.slice(0, 40)}`);
      continue;
    }

    const updates = jobs.map((j) => ({
      externalId: j.externalId,
      description: j.description ?? '',
      // An adapter that reports nothing gets MISSING rather than a guess —
      // never default a body-less row to LIST.
      descriptionSource: (j as { descriptionSource?: string }).descriptionSource ?? 'MISSING',
    }));
    const withBody = updates.filter((u) => u.description.length >= 200).length;
    totals.fetched += updates.length;
    totals.withBody += withBody;
    totals.missing += updates.length - withBody;

    if (!apply) {
      console.log(
        `  ${(provider + '/' + identifier).padEnd(44)} fetched=${String(updates.length).padStart(5)} ` +
          `withBody=${String(withBody).padStart(5)}`,
      );
      continue;
    }

    let changed = 0, unchanged = 0, notFound = 0;
    for (let i = 0; i < updates.length; i += BATCH) {
      const res = await api!.repairDescriptions(provider.toLowerCase(), updates.slice(i, i + BATCH));
      changed += res.changed; unchanged += res.unchanged; notFound += res.notFound;
    }
    totals.changed += changed; totals.unchanged += unchanged; totals.notFound += notFound;
    console.log(
      `  ${(provider + '/' + identifier).padEnd(44)} fetched=${String(updates.length).padStart(5)} ` +
        `changed=${String(changed).padStart(5)} unchanged=${String(unchanged).padStart(4)} notFound=${notFound}`,
    );
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`
=================================================
boards fetched OK        ${cohort.length - totals.failed} of ${cohort.length}
postings fetched         ${totals.fetched}
  with a real body       ${totals.withBody}
  still without one      ${totals.missing}   <- recorded MISSING, gate holds them`);
  if (apply) {
    console.log(`rows CHANGED             ${totals.changed}   <- previously unreadable, now readable
rows already correct     ${totals.unchanged}
not in corpus            ${totals.notFound}   <- new since last crawl; NOT inserted by repair

Changed rows have a new contentHash, so their decisions re-open and the belt
will re-judge them. That is correct — they were judged blind.`);
  } else {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
