/**
 * Step 10 — ingest the verified India-cohort boards so their jobs can be JUDGED.
 *
 * Everything before this was fetch-only. This writes, so it follows the Workday
 * canary discipline: dry-run by default, one board at a time, and the standing
 * reconciliation guards do the protecting.
 *
 * THE QUESTION: what is the REAL actionable/company for an India-first,
 * company-first discovery channel? Every figure so far has been a projection
 * using the corpus-wide 4.6% eligible→actionable rate, applied to a job mix it
 * was not measured on. Judging replaces the projection with a measurement, and
 * that number decides whether this channel is expanded, extended (Darwinbox,
 * rendering) or dropped.
 *
 * ATTRIBUTION IS THE POINT, so it is set explicitly:
 *   discoveredBy  = 'bangalore-map'   what introduced the COMPANY
 *   acquiredFrom  = greenhouse | keka | lever | ashby | …   where the JOB came from
 * Collapsing those is what made FreeHire read as 67.1% of actionable when the
 * true figure was 92.7%. A channel measured through the wrong column will be
 * credited to whichever ATS happened to serve the page.
 *
 * SAFETY: goes through POST /internal/boards/ingest, the same path FreeHire
 * uses. That path never retires anything — it upserts and enqueues embeddings.
 * Company-scoped retirement (syncCompanyJobs) is deliberately NOT used here, so
 * no existing job from any source can be touched by this run.
 *
 *   npx tsx src/scripts/ingest-india-cohort.ts <boards.tsv>            # dry run
 *   npx tsx src/scripts/ingest-india-cohort.ts <boards.tsv> --ingest   # write
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import type { BoardJob, NormalizedJob } from '@careeros/shared';
import { ApiClient } from '../api-client';
import type { AtsAdapter } from '../adapters/types';
import { greenhouseAdapter } from '../adapters/greenhouse';
import { leverAdapter } from '../adapters/lever';
import { ashbyAdapter } from '../adapters/ashby';
import { workableAdapter } from '../adapters/workable';
import { smartrecruitersAdapter } from '../adapters/smartrecruiters';
import { recruiteeAdapter } from '../adapters/recruitee';
import { breezyAdapter } from '../adapters/breezy';
import { kekaAdapter } from '../adapters/keka';
import { workdayAdapter } from '../adapters/workday';

const ADAPTERS: Record<string, AtsAdapter> = {
  GREENHOUSE: greenhouseAdapter,
  LEVER: leverAdapter,
  ASHBY: ashbyAdapter,
  WORKABLE: workableAdapter,
  SMARTRECRUITERS: smartrecruitersAdapter,
  RECRUITEE: recruiteeAdapter,
  BREEZY: breezyAdapter,
  KEKA: kekaAdapter,
  WORKDAY: workdayAdapter,
};

const DISCOVERY_SOURCE = 'bangalore-map';
const INDIA_RE =
  /india|bengaluru|bangalore|mumbai|pune|new delhi|delhi|hyderabad|chennai|noida|gurgaon|gurugram|indore|kolkata|ahmedabad|jaipur|kochi|remote/i;
const MAX_AGE_DAYS = 45;

function isFreshIndia(j: NormalizedJob): boolean {
  const india = j.country === 'IN' || INDIA_RE.test(`${j.location ?? ''} ${j.title ?? ''}`);
  if (!india) return false;
  // No date means NOT fresh. Absence of a date is not evidence of recency —
  // the Workday boards carried postings last touched in 2022.
  if (!j.postedAt) return false;
  const ms = Date.parse(j.postedAt);
  return Number.isFinite(ms) && (Date.now() - ms) / 86_400_000 <= MAX_AGE_DAYS;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  const ingest = process.argv.includes('--ingest');
  if (!file) {
    console.error('usage: ingest-india-cohort.ts <boards.tsv> [--ingest]');
    process.exit(1);
  }

  const boards = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [name, provider, identifier] = l.split('\t');
      return { name, provider, identifier };
    })
    .filter((b) => b.name && b.provider && b.identifier && ADAPTERS[b.provider]);

  console.log(
    `${boards.length} boards with an adapter | mode: ${ingest ? 'INGEST (writes)' : 'DRY RUN'}\n`,
  );

  const api = ingest ? new ApiClient() : null;
  let totalFresh = 0;
  let totalCreated = 0;
  let totalDup = 0;

  for (const b of boards) {
    let jobs: NormalizedJob[];
    try {
      jobs = await ADAPTERS[b.provider].fetchJobs(b.identifier);
    } catch (err) {
      console.log(`  ${b.name.padEnd(30)} FETCH FAILED ${(err as Error).message.slice(0, 50)}`);
      continue;
    }

    const fresh = jobs.filter(isFreshIndia);
    totalFresh += fresh.length;
    if (fresh.length === 0) {
      console.log(`  ${b.name.padEnd(30)} ${b.provider.padEnd(16)} 0 fresh India — skipped`);
      continue;
    }

    const entries: BoardJob[] = fresh.map((job) => ({
      company: {
        name: b.name,
        website: null,
        // The apply URL lets the API re-derive the ATS itself (ADR-11 evidence)
        // rather than trusting what this script asserts.
        atsHintUrl: job.url,
        sourceSlug: b.identifier,
      },
      job,
    }));

    if (!ingest) {
      console.log(
        `  ${b.name.padEnd(30)} ${b.provider.padEnd(16)} would ingest ${fresh.length}`,
      );
      continue;
    }

    // source = where the JOB came from; discoverySource = what found the COMPANY.
    const res = await api!.ingestBoardJobs(b.provider.toLowerCase(), entries, DISCOVERY_SOURCE);
    totalCreated += res.created;
    totalDup += res.duplicates ?? 0;
    console.log(
      `  ${b.name.padEnd(30)} ${b.provider.padEnd(16)} ` +
        `fresh=${String(fresh.length).padStart(3)} new=${String(res.created).padStart(3)} ` +
        `dup=${res.duplicates ?? 0}`,
    );
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`
=================================================
fresh India jobs found      ${totalFresh}`);
  if (ingest) {
    console.log(`newly created               ${totalCreated}
already present (dup)       ${totalDup}   <- NOT incremental supply

discoveredBy = '${DISCOVERY_SOURCE}' | acquiredFrom = the ATS each job came from
Embeddings are enqueued by ingest; the evaluation belt judges on its own 10m
tick. Actionable yield is only readable once those jobs are judged.`);
  } else {
    console.log(`
DRY RUN — nothing written. Re-run with --ingest.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
