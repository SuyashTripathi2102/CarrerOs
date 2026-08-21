import type { NormalizedJob } from '@careeros/shared';
import { htmlToText } from './html';
import { AtsAdapter, BoardFetch, capDescription, workModeFromText } from './types';

/**
 * Workday CXS adapter.
 *
 * Built to reduce single-source dependency, not to raise the job count.
 * Measured 2026-08-20: FreeHire supplied 76.7% of all actionable opportunities,
 * and the 104 companies identified as Workday were reachable through FreeHire
 * ALONE — 302 jobs between them. The same tenants expose thousands more
 * directly. Success is `FreeHire share of actionable < 50%`, not volume.
 *
 * See docs/WORKDAY_ADAPTER_DESIGN.md for the full design and the eight
 * assumptions that are still unproven.
 *
 * ── Two endpoints ───────────────────────────────────────────────────────────
 *   LIST    POST /wday/cxs/{tenant}/{site}/jobs   {appliedFacets,limit,offset}
 *   DETAIL  GET  /wday/cxs/{tenant}/{site}{externalPath}
 *
 * The LIST payload is deliberately thin — title, externalPath, bulletFields and
 * a RELATIVE date ("Posted 30+ Days Ago"). The DETAIL payload carries what the
 * pipeline actually needs: a structured `country`, a real ISO `startDate`, and
 * the description. So detail-fetching is not an optimisation, it is the only
 * source of trustworthy country and date.
 *
 * ── Three hazards this file exists to survive ───────────────────────────────
 *  1. `total` CAPS AT 2000. Accenture reports total=2000 while offset=2500
 *     still returns rows (~43k India jobs). Terminating on `offset >= total`
 *     would silently truncate the largest tenants.
 *  2. SIX TENANTS REPEAT PAGES — fractal, nasdaq, arrow, nxp, salesforce,
 *     alight. A naive `while (rows.length > 0)` never terminates on them.
 *  3. `limit` IS CAPPED AT 20. Requests for 50/100/200 error outright.
 */

const UA = 'CareerOS/0.1 (personal job-search agent)';

/** Hard API ceiling — 50/100/200 all error. */
const PAGE_SIZE = 20;
/** Listing pages per tenant. Chosen bound, not a measured optimum. */
const MAX_PAGES = Number(process.env.WORKDAY_MAX_PAGES ?? 25);
/** Parallel detail fetches per tenant. Deliberately low: no rate limit has ever
 *  been observed, but only because nothing has pushed hard enough to find one. */
const DETAIL_CONCURRENCY = Number(process.env.WORKDAY_DETAIL_CONCURRENCY ?? 3);
const PAGE_DELAY_MS = 150;
const LIST_TIMEOUT_MS = 20_000;
const DETAIL_TIMEOUT_MS = 15_000;
/** Only jobs a human could still act on; mirrors RECONCILE_MAX_AGE_DAYS. */
const MAX_AGE_DAYS = 45;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const INDIA_RE =
  /india|bengaluru|bangalore|mumbai|pune|new delhi|delhi|hyderabad|chennai|noida|gurgaon|gurugram|indore|kolkata|ahmedabad|jaipur|kochi|trivandrum|chandigarh|gift city/i;

interface JobPosting {
  title?: string;
  externalPath?: string;
  postedOn?: string;
  bulletFields?: string[];
}

interface ListResponse {
  total?: number;
  jobPostings?: JobPosting[];
  facets?: FacetGroup[];
}

interface FacetGroup {
  facetParameter?: string;
  values?: FacetGroup[];
  descriptor?: string;
  id?: string;
  count?: number;
}

interface DetailResponse {
  jobPostingInfo?: {
    title?: string;
    jobDescription?: string;
    location?: string;
    country?: { descriptor?: string };
    startDate?: string;
    postedOn?: string;
    jobReqId?: string;
    externalUrl?: string;
  };
}

/**
 * Workday returns a DATE (`"2026-08-19"`), but `NormalizedJobSchema` requires a
 * full ISO datetime — the ingest choke point rejects a bare date with
 * "Invalid ISO datetime". Widened to midnight UTC rather than loosening the
 * schema: the contract is shared by every adapter and should not bend for one.
 *
 * Returns null on anything unparseable so a bad upstream value becomes UNKNOWN
 * rather than a fabricated timestamp.
 */
export function toIsoDateTime(value: string | undefined | null): string | null {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const candidate = dateOnly.test(value) ? `${value}T00:00:00.000Z` : value;
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Parsed `tenant/dc/site`. Legacy two-part identifiers are unusable. */
export interface WorkdayTenant {
  tenant: string;
  dc: string;
  site: string;
}

export function parseIdentifier(identifier: string): WorkdayTenant | null {
  const parts = (identifier ?? '').split('/').filter(Boolean);
  // Legacy rows stored `tenant/site` and dropped the datacenter; without it the
  // host cannot be rebuilt, so they must be backfilled rather than guessed.
  if (parts.length !== 3) return null;
  const [tenant, dc, site] = parts;
  if (!/^wd\d+$/i.test(dc)) return null;
  return { tenant, dc, site };
}

const listUrl = (t: WorkdayTenant) =>
  `https://${t.tenant}.${t.dc}.myworkdayjobs.com/wday/cxs/${t.tenant}/${t.site}/jobs`;
const detailUrl = (t: WorkdayTenant, path: string) =>
  `https://${t.tenant}.${t.dc}.myworkdayjobs.com/wday/cxs/${t.tenant}/${t.site}${path}`;

/**
 * Age from the LIST payload's prose. Returns a bound, never a fabricated value.
 *
 * "Posted 30+ Days Ago" is a LOWER BOUND compatible with 31 days or 300.
 * Mapping it to exactly 30 would let long-dead postings through the freshness
 * gate — the same class of error as treating an empty crawl as an empty board.
 * Freshness is decided on the DETAIL payload's real `startDate`; this is only a
 * cheap pre-filter and must never discard an unbounded row.
 */
export function listingAgeBound(postedOn: string | undefined): {
  kind: 'EXACT' | 'LOWER_BOUND' | 'UNKNOWN';
  days: number | null;
} {
  if (!postedOn) return { kind: 'UNKNOWN', days: null };
  const s = postedOn.toLowerCase();
  if (s.includes('today') || s.includes('just posted')) return { kind: 'EXACT', days: 0 };
  if (s.includes('yesterday')) return { kind: 'EXACT', days: 1 };
  const plus = s.match(/(\d+)\+\s*days?/);
  if (plus) return { kind: 'LOWER_BOUND', days: Number(plus[1]) };
  const exact = s.match(/(\d+)\s*days?/);
  if (exact) return { kind: 'EXACT', days: Number(exact[1]) };
  return { kind: 'UNKNOWN', days: null };
}

/** Could this listing still be within the freshness window? Never a hard no on
 *  a bound — only an EXACT age past the cutoff is grounds to skip. */
export function couldBeFresh(postedOn: string | undefined): boolean {
  const a = listingAgeBound(postedOn);
  if (a.kind === 'EXACT') return (a.days ?? 0) <= MAX_AGE_DAYS;
  return true; // LOWER_BOUND and UNKNOWN are resolved by the detail fetch
}

/** Cheap India pre-filter over listing fields. Coarse ON PURPOSE — it only
 *  avoids detail-fetching obvious non-India rows; `country` from the detail
 *  payload is the authority. */
export function listingLooksIndian(p: JobPosting): boolean {
  return INDIA_RE.test([p.title, p.externalPath, ...(p.bulletFields ?? [])].join(' '));
}

/** Locate the India facet id, when the tenant exposes a country facet at all.
 *  Measured split across 104 tenants: locationCountry 41 · locations 54 · none 9.
 *  `locations` counts are NOT usable — they double-count multi-location jobs
 *  (fractal: total 132, buckets sum 313). */
export function findIndiaFacet(facets: FacetGroup[] | undefined): { param: string; id: string } | null {
  const group = (facets ?? []).find((f) => f.facetParameter === 'locationMainGroup');
  const country = (group?.values ?? []).find((v) => v.facetParameter === 'locationCountry');
  if (!country) return null;
  const india = (country.values ?? []).find((v) => /^india$/i.test(v.descriptor ?? ''));
  if (!india?.id) return null;
  return { param: 'locationCountry', id: india.id };
}

async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Page a tenant's board.
 *
 * THREE independent stop conditions, and `offset >= total` is deliberately NOT
 * one of them — see hazard 1 in the file header.
 */
export async function listAll(
  t: WorkdayTenant,
  appliedFacets: Record<string, string[]>,
  maxPages = MAX_PAGES,
): Promise<{
  postings: JobPosting[];
  pages: number;
  repeatedPage: boolean;
  /** Set when the walk stopped short of the listing's end. See `truncated`. */
  truncatedReason: string | null;
}> {
  const seen = new Set<string>();
  const postings: JobPosting[] = [];
  let pages = 0;
  let repeatedPage = false;
  let truncatedReason: string | null = null;

  for (let offset = 0; pages < maxPages; offset += PAGE_SIZE) {
    let page: ListResponse;
    try {
      page = await postJson<ListResponse>(
        listUrl(t),
        { appliedFacets, limit: PAGE_SIZE, offset, searchText: '' },
        LIST_TIMEOUT_MS,
      );
    } catch (err) {
      // Keep what we have, but SAY that it is partial. The comment that used to
      // sit here claimed "syncCompanyJobs will not retire anything it did not
      // see" — which is exactly backwards: it retires precisely what it did not
      // see (`externalId notIn seenIds`). A silent partial walk is therefore a
      // mass-retirement waiting for the next crawl.
      truncatedReason = `list request failed at offset ${offset}: ${(err as Error).message}`;
      console.log(`[workday] ${t.tenant} list @${offset} failed: ${(err as Error).message}`);
      break;
    }
    pages++;
    const rows = page.jobPostings ?? [];
    if (rows.length === 0) break;

    let fresh = 0;
    for (const r of rows) {
      const key = r.externalPath;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      postings.push(r);
      fresh++;
    }
    // Six tenants return the same page forever; without this they never stop.
    if (fresh === 0) {
      repeatedPage = true;
      break;
    }
    if (rows.length < PAGE_SIZE) break;
    // The cap is about to stop a walk that was STILL YIELDING new postings, so
    // the listing has a tail we never reached. Measured 2026-08-20: 5 of the 9
    // canary tenants hit this, and Accenture holds ~43k India postings against
    // a 500-listing ceiling. Distinguishing this from a natural end is the
    // whole point — the natural ends above leave truncatedReason null.
    if (pages >= maxPages) {
      truncatedReason = `page cap reached (${maxPages} pages) with the listing still yielding`;
    }
    await sleep(PAGE_DELAY_MS);
  }

  return { postings, pages, repeatedPage, truncatedReason };
}

/** Bounded-concurrency map. Keeps upstream load predictable. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface WorkdayStats {
  listed: number;
  indiaCandidates: number;
  detailFetched: number;
  detailFailed: number;
  acceptedIndiaFresh: number;
  pages: number;
  repeatedPage: boolean;
  facetFiltered: boolean;
}

let lastStats: WorkdayStats | null = null;
export const workdayLastStats = (): WorkdayStats | null => lastStats;

async function fetchBoardInternal(identifier: string): Promise<BoardFetch> {
    const t = parseIdentifier(identifier);
    if (!t) {
      // Legacy `tenant/site` rows land here. Throwing (rather than returning [])
      // marks the CrawlRun FAILED, which retires nothing — returning an empty
      // list would look like a successful empty board.
      throw new Error(`workday: identifier must be tenant/dc/site, got "${identifier}"`);
    }

    // One probe request: gives the facets AND the first page.
    const probe = await postJson<ListResponse>(
      listUrl(t),
      { appliedFacets: {}, limit: PAGE_SIZE, offset: 0, searchText: '' },
      LIST_TIMEOUT_MS,
    );
    const india = findIndiaFacet(probe.facets);

    // Strategy A: server-side country facet (41 of 104 tenants).
    // Strategies B/C: no usable country facet — list everything and pre-filter
    // locally, because `locations` facet counts double-count multi-location jobs.
    const { postings, pages, repeatedPage, truncatedReason } = await listAll(
      t,
      india ? { [india.param]: [india.id] } : {},
    );

    const candidates = postings.filter(
      (p) => p.externalPath && (india ? true : listingLooksIndian(p)) && couldBeFresh(p.postedOn),
    );

    const details = await mapLimit(candidates, DETAIL_CONCURRENCY, async (p) => {
      try {
        const d = await getJson<DetailResponse>(detailUrl(t, p.externalPath!), DETAIL_TIMEOUT_MS);
        return { p, info: d.jobPostingInfo ?? null };
      } catch {
        return { p, info: null };
      }
    });

    const jobs: NormalizedJob[] = [];
    let detailFailed = 0;

    for (const { p, info } of details) {
      if (!info) {
        detailFailed++;
        continue; // no country, no date, no description — cannot judge it
      }
      // Country is authoritative here; the listing pre-filter was only a hint.
      const country = info.country?.descriptor ?? null;
      const locationText = [info.location, country].filter(Boolean).join(', ');
      const isIndia = country ? /^india$/i.test(country) : INDIA_RE.test(locationText);
      if (!isIndia) continue;

      // Freshness on the REAL date. Rows without one are kept rather than
      // guessed at — ingest applies the same age rule downstream.
      if (info.startDate) {
        const ageDays = Math.floor((Date.now() - Date.parse(info.startDate)) / 86_400_000);
        if (Number.isFinite(ageDays) && ageDays > MAX_AGE_DAYS) continue;
      }

      const description = htmlToText(info.jobDescription ?? '');
      jobs.push({
        externalId: info.jobReqId || p.externalPath!,
        title: info.title || p.title || '',
        description: capDescription(description),
        url: info.externalUrl || `https://${t.tenant}.${t.dc}.myworkdayjobs.com/${t.site}${p.externalPath}`,
        location: locationText || null,
        country: country && /^india$/i.test(country) ? 'IN' : null,
        workMode: workModeFromText(`${info.title ?? ''} ${locationText}`),
        postedAt: toIsoDateTime(info.startDate),
      });
    }

    lastStats = {
      listed: postings.length,
      indiaCandidates: candidates.length,
      detailFetched: details.length,
      detailFailed,
      acceptedIndiaFresh: jobs.length,
      pages,
      repeatedPage,
      facetFiltered: Boolean(india),
    };

    console.log(
      `[workday] ${t.tenant}/${t.site}: listed=${postings.length} pages=${pages}` +
        `${repeatedPage ? ' [REPEATED-PAGE]' : ''}${truncatedReason ? ' [TRUNCATED]' : ''} ` +
        `facet=${india ? 'country' : 'local'} ` +
        `candidates=${candidates.length} detailFailed=${detailFailed} accepted=${jobs.length}`,
    );

  return { jobs, complete: truncatedReason === null, reason: truncatedReason ?? undefined };
}

export const workdayAdapter: AtsAdapter = {
  source: 'workday',
  async fetchJobs(identifier: string): Promise<NormalizedJob[]> {
    return (await fetchBoardInternal(identifier)).jobs;
  },
  async fetchBoard(identifier: string): Promise<BoardFetch> {
    return fetchBoardInternal(identifier);
  },
};
