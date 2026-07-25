import { get } from 'node:https';
import type { BoardJob } from '@careeros/shared';
import { capDescription, workModeFromText } from './types';

/**
 * IPv4-forced JSON GET. The prod box's IPv6 egress is broken and Adzuna's host
 * resolves to AWS IPv6 addresses first, so global fetch/undici hangs with
 * ETIMEDOUT. family:4 pins the socket to IPv4 (verified reachable).
 */
function getJson<T>(url: string, timeoutMs = 12_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = get(
      url,
      {
        family: 4,
        headers: { 'user-agent': 'CareerOS/0.1 (personal job-search agent)', accept: 'application/json' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          res.resume();
          reject(new Error(`GET -> ${status}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Adzuna — a permitted job-aggregator API (register a free app_id/app_key at
 * developer.adzuna.com). It aggregates listings across many boards and company
 * sites, INCLUDING India, searchable by role + location. This is the honest,
 * ToS-safe way to get real volume: an official API with attribution (we store
 * and show the original redirect_url), not scraping a protected portal.
 *
 * We query the user's target roles across India and normalise every hit into a
 * BoardJob — the same discovery-flywheel input as RemoteOK/HN, so companies we
 * don't know yet get created and monitored.
 */

const BASE = 'https://api.adzuna.com/v1/api/jobs';

// The roles a Node/React/full-stack engineer actually wants. Each becomes one
// India-wide query. Keep tight so the feed is relevant, not flooded with noise.
const QUERIES = [
  'node.js developer',
  'full stack developer',
  'react developer',
  'backend developer',
  'mern stack developer',
  'javascript developer',
];

interface AdzunaResult {
  id?: string;
  title?: string;
  description?: string;
  redirect_url?: string;
  created?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  salary_min?: number;
  salary_max?: number;
  category?: { label?: string };
}
interface AdzunaResponse {
  results?: AdzunaResult[];
  count?: number;
}

const clean = (s: string): string =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const ROLE_OK = /engineer|developer|programmer|\bsde\b|full.?stack|back.?end|front.?end|software|\bmern\b/i;

/** Pure: normalise Adzuna results into BoardJobs (India, dev roles only). */
export function mapAdzunaResults(results: AdzunaResult[]): BoardJob[] {
  const seen = new Set<string>();
  const out: BoardJob[] = [];
  for (const r of results) {
    const company = r.company?.display_name?.trim();
    const title = r.title ? clean(r.title) : '';
    if (!r.id || !company || !title) continue;
    if (!ROLE_OK.test(title)) continue; // aggregator returns off-role noise — drop it
    const externalId = `adzuna-${r.id}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    const location = r.location?.display_name ?? null;
    out.push({
      company: { name: company },
      job: {
        externalId,
        title,
        description: capDescription(clean(r.description ?? '')),
        url: r.redirect_url ?? `https://www.adzuna.in/details/${r.id}`,
        location,
        country: 'IN',
        workMode: workModeFromText(`${title} ${location ?? ''}`),
        salaryMin: r.salary_min ? Math.round(r.salary_min) : null,
        salaryMax: r.salary_max ? Math.round(r.salary_max) : null,
        currency: r.salary_min ? 'INR' : null,
        postedAt: r.created ?? null,
      },
    });
  }
  return out;
}

/**
 * Fetch recent India dev jobs across the target roles. No key → empty (logged),
 * like every optional source. Bounded: one page (50) per role, freshest first.
 */
export async function fetchAdzunaJobs(): Promise<BoardJob[]> {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    console.log('[adzuna] ADZUNA_APP_ID/ADZUNA_APP_KEY not set — skipping (register free at developer.adzuna.com)');
    return [];
  }

  const auth = `app_id=${appId}&app_key=${appKey}`;
  const all: BoardJob[] = [];
  const seen = new Set<string>();
  // A few pages per role (50 each) — ~3–5× the volume, still ~18 calls/sweep
  // (well within the free tier). Stops early when a role runs out of results.
  const PAGES = 3;
  for (const what of QUERIES) {
    for (let page = 1; page <= PAGES; page++) {
      const url =
        `${BASE}/in/search/${page}?${auth}&results_per_page=50&max_days_old=28&sort_by=date` +
        `&what=${encodeURIComponent(what)}&content-type=application/json`;
      let batch: BoardJob[] = [];
      try {
        const res = await getJson<AdzunaResponse>(url);
        batch = mapAdzunaResults(res.results ?? []);
      } catch (err) {
        console.log(`[adzuna] query "${what}" p${page} failed: ${String(err)}`);
        break;
      }
      if (batch.length === 0) break; // no more pages for this role
      for (const job of batch) {
        if (seen.has(job.job.externalId)) continue;
        seen.add(job.job.externalId);
        all.push(job);
      }
      await new Promise((r) => setTimeout(r, 1200)); // gentle on the free tier
    }
  }
  console.log(`[adzuna] fetched ${all.length} India dev jobs across ${QUERIES.length} role queries`);
  return all;
}
