import type { NormalizedJob } from '@careeros/shared';
import { htmlToText } from './html';
import {
  AtsAdapter,
  capDescription,
  fetchJson,
  workModeFromText,
} from './types';

/**
 * Keka (Indian ATS, Hyderabad) — public careers API discovered 2026-07-09.
 * The identifier is the tenant subdomain; the org document id lives only in
 * page content, so we resolve it per crawl:
 *   GET  https://{tenant}.keka.com/careers/            → contains /ats/documents/{uuid}/
 *   GET  .../careers/api/embedjobs/default/active/{uuid} → job list JSON
 * Job page: https://{tenant}.keka.com/careers/jobdetails/{id}
 */

interface KekaJob {
  id: number;
  title: string;
  description?: string; // HTML
  jobLocations?: { name?: string; city?: string; countryCode?: string }[];
  publishedOn?: string;
  skillNames?: string[];
}

/**
 * Keka marks "no publish date" with .NET's DateTime.MinValue
 * (`0001-01-01T00:00:00`). That is unknown, not a date: read as local time it
 * becomes year 0 and failed FloBiz's whole crawl (2026-11-21, gap N-01). An
 * unparseable value is unknown too — `new Date(x).toISOString()` would throw.
 */
export function kekaPostedAt(publishedOn: string | undefined): string | null {
  if (!publishedOn || publishedOn.startsWith('0001-01-01')) return null;
  const t = new Date(publishedOn);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

const ORG_ID_RE =
  /\/ats\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

export const kekaAdapter: AtsAdapter = {
  source: 'keka',

  async fetchJobs(tenant: string): Promise<NormalizedJob[]> {
    const base = `https://${encodeURIComponent(tenant)}.keka.com`;

    const page = await fetch(`${base}/careers/`, {
      headers: { 'user-agent': 'CareerOS/0.1 (personal job-search agent)' },
    });
    if (!page.ok) throw new Error(`GET ${base}/careers/ -> ${page.status}`);
    const html = await page.text();
    const orgId = ORG_ID_RE.exec(html)?.[1];
    if (!orgId)
      throw new Error(`Keka org id not found on ${tenant} careers page`);

    const jobs = await fetchJson<KekaJob[]>(
      `${base}/careers/api/embedjobs/default/active/${orgId}`,
    );

    return (jobs ?? []).map((j) => {
      const loc = j.jobLocations?.[0];
      const location = loc?.name ?? loc?.city ?? null;
      return {
        externalId: String(j.id),
        title: j.title,
        description: capDescription(htmlToText(j.description ?? '')),
        url: `${base}/careers/jobdetails/${j.id}`,
        location,
        country: loc?.countryCode ?? null,
        workMode: workModeFromText(`${j.title} ${location ?? ''}`),
        postedAt: kekaPostedAt(j.publishedOn),
      };
    });
  },
};
