import type { BoardJob } from '@careeros/shared';
import { capDescription, fetchJson, workModeFromText } from './types';

/**
 * FreeHire (freehire.me) — a keyless public aggregator that fans out across
 * 80+ ATS platforms (greenhouse, lever, workday, freshteam, smartrecruiters,
 * breezy, comeet …) plus its own crawlers.
 *
 * Why this source exists: measured 2026-08-13, CareerOS's India supply was
 * 70% Senior/Lead/Staff and only 2 of 105 classified engineering jobs were
 * JUNIOR — because every India source we had was a YC-style startup ATS board.
 * FreeHire reports ~65k India postings and covers workday + freshteam, neither
 * of which CareerOS has an adapter for.
 *
 * CONTROLLED PAGINATION, not a bulk import (revised 2026-08-15). The original
 * rule here was "one page per role, never paginate", on the reasoning that a
 * source dumping 65k rows costs $0.019/job in classification and buries the
 * signal. The reasoning was right; two of its numbers were not.
 *
 * Measured instead:
 *   - the first page is 5.6% of what the source offers (512 of 9,210 India rows)
 *   - 2,301 of a 2,703-row sample were genuinely NEW — zero URL overlap with
 *     greenhouse, lever, workable, breezy or ashby
 *   - 899 distinct companies in one sample, against 97 held from this source
 *   - freshness p50 10 days, the best of any source
 *   - real cost is $0.0073 per decision end-to-end, not $0.019 — so ~2,300 new
 *     jobs is roughly $17, not $44
 *
 * So it is worth paginating, and still worth capping: the "full stack" query
 * alone reports 5,316 rows and would otherwise dominate the corpus. The cap is
 * env-tunable (FREEHIRE_MAX_PER_QUERY) precisely so the ladder 100 -> 300 ->
 * 500 -> 1000 can be walked while watching yield, rather than guessed at once.
 *
 * Blocked on ADR-11 until 2026-08-15: scaling company volume before company
 * identity was protected would have fragmented hiring velocity, referrals and
 * outcomes at a scale that cannot be retrofitted.
 *
 * Hosted-service dependency: reads are public, best-effort, no SLA. An outage
 * degrades this source to empty rather than failing the crawl.
 */

const SEARCH_PATH = '/api/v1/agent/jobs/search';
const BASE = process.env.FREEHIRE_API_URL?.replace(/\/+$/, '') || 'https://freehire.me';

/** Target roles, one query each. Mirrors the user's preferredRoles. */
const ROLE_QUERIES = [
  'node.js',
  'react',
  'full stack',
  'backend',
  'javascript',
  'mern',
] as const;

/** API page size. The source caps a single response at 100. */
const PAGE_SIZE = 100;

/**
 * Rows pulled per role query, across as many pages as needed.
 *
 * Default 300 — a measured 3x on the previous single page, ~1,400 genuinely new
 * jobs at roughly $10, and easily reversible. Raise deliberately while watching
 * the source scorecard:
 *
 *   FREEHIRE_MAX_PER_QUERY=100   previous behaviour
 *   FREEHIRE_MAX_PER_QUERY=300   default
 *   FREEHIRE_MAX_PER_QUERY=1000  ~2,300 new jobs, ~$17
 *
 * Spend is bounded independently by the API's daily budget guard, which is what
 * keeps a raised cap from turning into a surprise bill.
 */
export function maxPerQuery(): number {
  const raw = process.env.FREEHIRE_MAX_PER_QUERY?.trim();
  if (!raw) return 300;
  const n = Number(raw);
  // Number('') === 0, and a typo must not silently disable the source.
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300;
}

/** Politeness gap between pages against a free, no-SLA public API. */
const PAGE_DELAY_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Only postings a human could still act on; matches RECONCILE_MAX_AGE_DAYS. */
const POSTED_WITHIN_DAYS = 45;

interface FreehireJob {
  public_slug?: string;
  source?: string;
  external_id?: string;
  url?: string;
  title?: string;
  company?: string;
  company_slug?: string;
  location?: string;
  description?: string;
  posted_at?: string;
  created_at?: string;
}

interface Envelope<T> {
  data?: T;
  meta?: { total?: number; limit?: number; offset?: number };
}

/** Strip markup/entities the aggregator passes through from source ATSs. */
const clean = (s: string): string =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;|&gt;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Same role guard the other aggregator adapters use. This is a CHEAP prefilter
 * to avoid paying classification on obvious non-engineering rows — it is NOT a
 * seniority or eligibility decision. CareerOS's classifier remains the sole
 * authority on years, specialization and coding responsibility; a title reading
 * "Full Stack Engineer" says nothing about whether it wants 2 years or 8.
 */
const ROLE_OK =
  /engineer|developer|programmer|\bsde\b|full.?stack|back.?end|front.?end|software|\bmern\b/i;

const validUrl = (u: string | undefined): string | null => {
  if (!u) return null;
  try {
    return new URL(u).toString();
  } catch {
    return null;
  }
};

/** Pure: normalise FreeHire rows into BoardJobs. Exported for tests. */
export function mapFreehireJobs(jobs: FreehireJob[]): BoardJob[] {
  const seen = new Set<string>();
  const out: BoardJob[] = [];

  for (const j of jobs) {
    const company = j.company?.trim();
    const title = j.title ? clean(j.title) : '';
    const url = validUrl(j.url);

    // A row without a company or a resolvable link would create a ghost
    // company and a dead apply link — the exact failure the RemoteOK incident
    // taught us to reject at the adapter, not downstream.
    if (!company || !title || !url) continue;
    if (!ROLE_OK.test(title)) continue;

    // Prefer the aggregator's stable slug; fall back to the upstream ATS id,
    // then the URL. Fingerprint dedup collapses cross-source duplicates later.
    const id = j.public_slug || j.external_id || url;
    const externalId = `freehire-${id}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    out.push({
      // company_slug is present on 100% of rows (measured over 3,000). It
      // fragments exactly like the name does — `zensar` vs
      // `zensar-technologies` — so under ADR-11 it is corroborating evidence,
      // never a canonical id. The confirming signal is the apply-URL tenant.
      company: { name: company, sourceSlug: j.company_slug?.trim() || null },
      job: {
        externalId,
        title,
        description: capDescription(clean(j.description ?? '')),
        url,
        location: j.location?.trim() || null,
        country: 'IN',
        workMode: workModeFromText(`${title} ${j.location ?? ''}`),
        postedAt: j.posted_at ?? j.created_at ?? null,
      },
    });
  }
  return out;
}

/** Telemetry for the source registry — reported per crawl, not just logged. */
export interface FreehireStats {
  queries: number;
  /** Pages actually fetched across all queries — the pagination signal. */
  pages: number;
  capPerQuery: number;
  fetched: number;
  mapped: number;
  rejected: number;
  duplicatesWithinRun: number;
  upstreamSources: string[];
  reportedTotal: number | null;
}

let lastStats: FreehireStats | null = null;
export const freehireLastStats = (): FreehireStats | null => lastStats;

/**
 * Fetch a filtered India slice across the target roles. Never throws: a source
 * outage yields an empty list so one aggregator cannot fail the whole crawl.
 */
export async function fetchFreehireJobs(): Promise<BoardJob[]> {
  const all: BoardJob[] = [];
  const seen = new Set<string>();
  const upstream = new Set<string>();
  let fetched = 0;
  let rejected = 0;
  let dupes = 0;
  let reportedTotal: number | null = null;

  const cap = maxPerQuery();
  let pages = 0;

  for (const q of ROLE_QUERIES) {
    let queryTotal: number | null = null;

    for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
      const params = new URLSearchParams({
        q,
        countries: 'IN',
        limit: String(PAGE_SIZE),
        offset: String(offset),
        semantic_ratio: '0', // keyword search; the semantic index is opt-in
        include_description: 'true',
        description_format: 'text',
        posted_within_days: String(POSTED_WITHIN_DAYS),
      });

      let env: Envelope<FreehireJob[]>;
      try {
        env = await fetchJson<Envelope<FreehireJob[]>>(`${BASE}${SEARCH_PATH}?${params}`);
      } catch (err) {
        // Best-effort source: abandon THIS query, keep the pages already
        // collected, and move on. One flaky page must not lose the rest.
        console.log(
          `[freehire] "${q}" @${offset} failed: ${err instanceof Error ? err.message : err} — skipping rest of query`,
        );
        break;
      }
      pages++;

      const rows = env.data ?? [];
      fetched += rows.length;
      if (typeof env.meta?.total === 'number') {
        queryTotal = env.meta.total;
        if (reportedTotal == null) reportedTotal = env.meta.total;
      }
      for (const r of rows) if (r.source) upstream.add(r.source);

      const mapped = mapFreehireJobs(rows);
      rejected += rows.length - mapped.length;

      for (const b of mapped) {
        if (seen.has(b.job.externalId)) {
          dupes++; // heavy across queries: "full stack" and "react" overlap ~20%
          continue;
        }
        seen.add(b.job.externalId);
        all.push(b);
      }

      // Short page or exhausted result set — no more to fetch for this role.
      if (rows.length < PAGE_SIZE) break;
      if (queryTotal != null && offset + PAGE_SIZE >= queryTotal) break;
      await sleep(PAGE_DELAY_MS);
    }
  }

  lastStats = {
    queries: ROLE_QUERIES.length,
    pages,
    capPerQuery: cap,
    fetched,
    mapped: all.length,
    rejected,
    duplicatesWithinRun: dupes,
    upstreamSources: [...upstream].sort(),
    reportedTotal,
  };

  console.log(
    `[freehire] ${ROLE_QUERIES.length} queries · ${pages} pages (cap ${cap}/query) · ` +
      `fetched=${fetched} accepted=${all.length} ` +
      `rejected=${rejected} dupes-in-run=${dupes} · upstream ATS: ${[...upstream].sort().join(', ')}` +
      (reportedTotal != null ? ` · source reports ${reportedTotal} India jobs` : ''),
  );

  return all;
}
