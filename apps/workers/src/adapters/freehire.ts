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
 * DELIBERATELY NOT a bulk import. We pull a filtered slice per target role,
 * newest-first, and let the normal pipeline decide. A source that dumps 65k
 * rows into the corpus costs $0.019/job in classification and buries the
 * signal — the point is fresh RELEVANT jobs, not volume.
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

/** Per query. Kept small on purpose — see the no-bulk-import note above. */
const PER_QUERY = 100;
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

  for (const q of ROLE_QUERIES) {
    const params = new URLSearchParams({
      q,
      countries: 'IN',
      limit: String(PER_QUERY),
      offset: '0',
      semantic_ratio: '0', // keyword search; the semantic index is opt-in
      include_description: 'true',
      description_format: 'text',
      posted_within_days: String(POSTED_WITHIN_DAYS),
    });

    let env: Envelope<FreehireJob[]>;
    try {
      env = await fetchJson<Envelope<FreehireJob[]>>(`${BASE}${SEARCH_PATH}?${params}`);
    } catch (err) {
      // Best-effort source: log and move to the next query.
      console.log(
        `[freehire] query "${q}" failed: ${err instanceof Error ? err.message : err} — skipping`,
      );
      continue;
    }

    const rows = env.data ?? [];
    fetched += rows.length;
    if (reportedTotal == null && typeof env.meta?.total === 'number') {
      reportedTotal = env.meta.total;
    }
    for (const r of rows) if (r.source) upstream.add(r.source);

    const mapped = mapFreehireJobs(rows);
    rejected += rows.length - mapped.length;

    for (const b of mapped) {
      if (seen.has(b.job.externalId)) {
        dupes++;
        continue;
      }
      seen.add(b.job.externalId);
      all.push(b);
    }
  }

  lastStats = {
    queries: ROLE_QUERIES.length,
    fetched,
    mapped: all.length,
    rejected,
    duplicatesWithinRun: dupes,
    upstreamSources: [...upstream].sort(),
    reportedTotal,
  };

  console.log(
    `[freehire] ${ROLE_QUERIES.length} queries · fetched=${fetched} accepted=${all.length} ` +
      `rejected=${rejected} dupes-in-run=${dupes} · upstream ATS: ${[...upstream].sort().join(', ')}` +
      (reportedTotal != null ? ` · source reports ${reportedTotal} India jobs` : ''),
  );

  return all;
}
