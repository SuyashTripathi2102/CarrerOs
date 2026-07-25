import type { BoardJob } from '@careeros/shared';
import { capDescription, fetchJson, workModeFromText } from './types';

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
  for (const what of QUERIES) {
    const url =
      `${BASE}/in/search/1?${auth}&results_per_page=50&max_days_old=21&sort_by=date` +
      `&what=${encodeURIComponent(what)}&content-type=application/json`;
    try {
      const res = await fetchJson<AdzunaResponse>(url);
      for (const job of mapAdzunaResults(res.results ?? [])) {
        if (seen.has(job.job.externalId)) continue;
        seen.add(job.job.externalId);
        all.push(job);
      }
    } catch (err) {
      console.log(`[adzuna] query "${what}" failed: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // gentle on the free tier
  }
  console.log(`[adzuna] fetched ${all.length} India dev jobs across ${QUERIES.length} role queries`);
  return all;
}
