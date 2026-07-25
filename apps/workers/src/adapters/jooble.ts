import { request } from 'node:https';
import type { BoardJob } from '@careeros/shared';
import { capDescription, workModeFromText } from './types';

/**
 * Jooble — a permitted job-aggregator API (free key at jooble.org/api/about,
 * ~500 requests/day). Complements Adzuna: another structured, India-covering
 * source that flows through the same BoardJob → ingest → embed → Opportunity
 * pipeline. The key goes in the URL path; the body is {keywords, location, page}.
 */

const QUERIES = [
  'node.js developer',
  'full stack developer',
  'react developer',
  'backend developer',
  'mern stack developer',
  'javascript developer',
];
const LOCATION = 'India';
const PAGES = 2;

interface JoobleJob {
  id?: number | string;
  title?: string;
  location?: string;
  snippet?: string;
  salary?: string;
  type?: string;
  link?: string;
  company?: string;
  updated?: string;
}
interface JoobleResponse {
  totalCount?: number;
  jobs?: JoobleJob[];
}

/** IPv4-forced JSON POST (this box's IPv6 egress is broken — see adzuna.ts). */
function postJson<T>(urlStr: string, bodyObj: unknown, timeoutMs = 12_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const u = new URL(urlStr);
    const req = request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        family: 4,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': 'CareerOS/0.1 (personal job-search agent)',
          accept: 'application/json',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          res.resume();
          reject(new Error(`POST -> ${status}`));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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

const validUrl = (u: string | undefined): string | null => {
  if (!u) return null;
  try {
    return new URL(u).toString();
  } catch {
    return null;
  }
};

/** Pure: normalise Jooble results into BoardJobs (dev roles, real company+link). */
export function mapJoobleJobs(jobs: JoobleJob[]): BoardJob[] {
  const seen = new Set<string>();
  const out: BoardJob[] = [];
  for (const j of jobs) {
    const company = j.company?.trim();
    const title = j.title ? clean(j.title) : '';
    const url = validUrl(j.link);
    // Require a company and a real link — aggregator rows without them would
    // create "Unknown" ghost companies and dead links in the index.
    if (!company || !title || !url) continue;
    if (!ROLE_OK.test(title)) continue;
    const externalId = `jooble-${j.id ?? url}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    out.push({
      company: { name: company },
      job: {
        externalId,
        title,
        description: capDescription(clean(j.snippet ?? '')),
        url,
        location: j.location ?? null,
        country: 'IN',
        workMode: workModeFromText(`${title} ${j.location ?? ''}`),
        postedAt: j.updated ?? null,
      },
    });
  }
  return out;
}

/** Fetch recent India dev jobs across the target roles. No key → empty (logged). */
export async function fetchJoobleJobs(): Promise<BoardJob[]> {
  const key = process.env.JOOBLE_API_KEY;
  if (!key) {
    console.log('[jooble] JOOBLE_API_KEY not set — skipping (free key at jooble.org/api/about)');
    return [];
  }
  const url = `https://jooble.org/api/${key}`;
  const all: BoardJob[] = [];
  const seen = new Set<string>();
  for (const keywords of QUERIES) {
    for (let page = 1; page <= PAGES; page++) {
      let batch: BoardJob[] = [];
      try {
        const resp = await postJson<JoobleResponse>(url, { keywords, location: LOCATION, page: String(page) });
        batch = mapJoobleJobs(resp.jobs ?? []);
      } catch (err) {
        console.log(`[jooble] "${keywords}" p${page} failed: ${String(err)}`);
        break;
      }
      if (batch.length === 0) break;
      for (const job of batch) {
        if (seen.has(job.job.externalId)) continue;
        seen.add(job.job.externalId);
        all.push(job);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  console.log(`[jooble] fetched ${all.length} India dev jobs across ${QUERIES.length} role queries`);
  return all;
}
