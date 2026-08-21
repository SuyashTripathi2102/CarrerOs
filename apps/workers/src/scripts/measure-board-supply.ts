/**
 * Measure the ACTUAL job supply behind verified boards. FETCH ONLY.
 *
 * Ingests nothing, writes nothing, judges nothing. It answers the one question
 * the discovery funnel could not: a count of verified boards is a count of
 * DOORS, not of jobs.
 *
 * Context (measured 2026-08-21): a 250-company India-first cohort produced 26
 * verified boards, of which 94.4% of the companies were new to CareerOS. That
 * proves independence of DISCOVERY. It says nothing about supply — the Workday
 * canary found boards carrying postings last touched in 2022.
 *
 * Uses the REAL production adapters, deliberately. A bespoke fetcher here would
 * measure something ingestion would never actually get: the same India filter,
 * the same freshness rule, the same normalization.
 *
 *   npx tsx src/scripts/measure-board-supply.ts <boards.tsv>
 *
 * boards.tsv: `name<TAB>PROVIDER<TAB>identifier<TAB>NEW|KNOWN`
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
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

/**
 * Mirrors crawl-company.processor.ts, plus Workday.
 *
 * Workday is NOT in that registry — the adapter exists and passed a nine-check
 * canary, but was never wired into the crawl path, so it is "built" and not
 * "enabled". Including it here measures what enabling it would buy; that is a
 * different question from what production fetches today, and the report keeps
 * the two apart.
 */
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
const WIRED_IN_PRODUCTION = new Set([
  'GREENHOUSE', 'LEVER', 'ASHBY', 'WORKABLE',
  'SMARTRECRUITERS', 'RECRUITEE', 'BREEZY', 'KEKA',
]);

const INDIA_RE =
  /india|bengaluru|bangalore|mumbai|pune|new delhi|delhi|hyderabad|chennai|noida|gurgaon|gurugram|indore|kolkata|ahmedabad|jaipur|kochi|remote/i;
const MAX_AGE_DAYS = 45;

interface Row {
  name: string;
  provider: string;
  identifier: string;
  known: string;
  total: number | null;
  india: number;
  fresh: number;
  error: string | null;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: measure-board-supply.ts <boards.tsv>');
    process.exit(1);
  }

  const boards = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [name, provider, identifier, known] = l.split('\t');
      return { name, provider, identifier, known: known ?? 'NEW' };
    })
    .filter((b) => b.name && b.provider && b.identifier);

  console.log(`${boards.length} verified boards from ${file}\n`);
  console.log('company                        provider          total  india  fresh<=45d');

  const rows: Row[] = [];
  for (const b of boards) {
    const adapter = ADAPTERS[b.provider];
    if (!adapter) {
      rows.push({ ...b, total: null, india: 0, fresh: 0, error: 'NO ADAPTER' });
      console.log(
        `${b.name.slice(0, 30).padEnd(31)}${b.provider.padEnd(18)}` + '   — no adapter —',
      );
      continue;
    }
    try {
      const jobs = await adapter.fetchJobs(b.identifier);
      const india = jobs.filter(
        (j) => j.country === 'IN' || INDIA_RE.test(`${j.location ?? ''} ${j.title ?? ''}`),
      );
      // Freshness on the stated date only. A posting with no date is NOT
      // counted fresh — absence of a date is not evidence of recency.
      const fresh = india.filter((j) => {
        if (!j.postedAt) return false;
        const ms = Date.parse(j.postedAt as unknown as string);
        return Number.isFinite(ms) && (Date.now() - ms) / 86_400_000 <= MAX_AGE_DAYS;
      });
      rows.push({ ...b, total: jobs.length, india: india.length, fresh: fresh.length, error: null });
      console.log(
        `${b.name.slice(0, 30).padEnd(31)}${b.provider.padEnd(18)}` +
          `${String(jobs.length).padStart(5)}${String(india.length).padStart(7)}${String(fresh.length).padStart(11)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rows.push({ ...b, total: null, india: 0, fresh: 0, error: msg.slice(0, 60) });
      console.log(`${b.name.slice(0, 30).padEnd(31)}${b.provider.padEnd(18)}   FAILED ${msg.slice(0, 40)}`);
    }
    await new Promise((r) => setTimeout(r, 800)); // polite
  }

  const ok = rows.filter((r) => r.error === null);
  const wired = ok.filter((r) => WIRED_IN_PRODUCTION.has(r.provider));
  const sum = (rs: Row[], k: 'total' | 'india' | 'fresh') =>
    rs.reduce((n, r) => n + (r[k] ?? 0), 0);

  const block = (label: string, rs: Row[], denom: number) => `
${label}
  boards fetched OK        ${rs.length} of ${denom}
  total postings           ${sum(rs, 'total')}
  India postings           ${sum(rs, 'india')}
  FRESH India (<=45d)      ${sum(rs, 'fresh')}
  fresh India per company  ${denom > 0 ? (sum(rs, 'fresh') / denom).toFixed(2) : '—'}`;

  console.log(block('=== ADAPTERS WIRED IN PRODUCTION TODAY ===', wired,
    boards.filter((b) => WIRED_IN_PRODUCTION.has(b.provider)).length));
  console.log(block('=== ALL ADAPTERS THAT EXIST (incl. unwired Workday) ===', ok, boards.length));

  const failed = rows.filter((r) => r.error);
  if (failed.length > 0) {
    console.log(`\nfailed / no adapter (${failed.length}):`);
    for (const f of failed) console.log(`  ${f.name.padEnd(30)} ${f.provider.padEnd(16)} ${f.error}`);
  }

  console.log(`
NOTE: fresh India postings are SUPPLY, not opportunities. The corpus converts
eligible jobs to actionable at 4.6%, and these are unjudged. Baselines for
actionable/company: YC-India 0.152 | jooble 0.320 | freehire 0.376.
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
