import { z } from 'zod';

/** Mirrors the Prisma AtsProvider enum — identical string values by design. */
export const AtsProviderSchema = z.enum([
  'GREENHOUSE',
  'LEVER',
  'ASHBY',
  'WORKDAY',
  'SMARTRECRUITERS',
  'RECRUITEE',
  'TEAMTAILOR',
  'WORKABLE',
  'BREEZY',
  // Indian ATS family (2026-07-09) — where Indian companies actually post
  'KEKA',
  'DARWINBOX',
  'ZOHO_RECRUIT',
  'FRESHTEAM',
  'OTHER',
  'UNKNOWN',
]);
export type AtsProviderName = z.infer<typeof AtsProviderSchema>;

export interface AtsDetection {
  provider: AtsProviderName;
  identifier: string | null;
}

/**
 * Detects an ATS provider + board identifier from any URL pointing at a
 * hosted job board or a specific posting on one. This is what turns
 * "here's a job/career link" into "we can crawl this company forever" —
 * the discovery pipeline's key move. Used by both the API (company create,
 * board-flywheel ingest) and the workers (career-page prober).
 */
export function detectAts(url: string): AtsDetection {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { provider: 'UNKNOWN', identifier: null };
  }
  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split('/').filter(Boolean);

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    // boards.greenhouse.io/{token}[/jobs/{id}] — "embed" pages put it in ?for=
    const token = segments[0] === 'embed' ? u.searchParams.get('for') : segments[0];
    return { provider: 'GREENHOUSE', identifier: token ?? null };
  }
  if (host === 'jobs.lever.co') {
    return { provider: 'LEVER', identifier: segments[0] ?? null };
  }
  if (host === 'jobs.ashbyhq.com') {
    return { provider: 'ASHBY', identifier: segments[0] ?? null };
  }
  if (host.endsWith('.myworkdayjobs.com')) {
    // {tenant}.wd{N}.myworkdayjobs.com/{site}
    //
    // The CXS API needs all THREE parts:
    //   POST https://{tenant}.{dc}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
    //
    // This previously returned `tenant/site` and dropped the datacenter, which
    // made the identifier unusable for crawling — abb/External_Career_Page
    // cannot be turned back into abb.wd3. Widening the identifier rather than
    // the AtsAdapter interface keeps Workday out of the generic pipeline:
    // `atsIdentifier` is already free-form per provider (Greenhouse stores a
    // board token, Lever a slug), so three segments is data, not schema.
    const [tenant, dc] = host.split('.');
    const site = segments.find((s) => !['en-US', 'wday'].includes(s));
    if (!site) return { provider: 'WORKDAY', identifier: null };
    return { provider: 'WORKDAY', identifier: `${tenant}/${dc}/${site}` };
  }
  if (host.endsWith('.recruitee.com')) {
    return { provider: 'RECRUITEE', identifier: host.split('.')[0] };
  }
  if (host.endsWith('.teamtailor.com')) {
    return { provider: 'TEAMTAILOR', identifier: host.split('.')[0] };
  }
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') {
    return { provider: 'SMARTRECRUITERS', identifier: segments[0] ?? null };
  }
  if (host === 'apply.workable.com') {
    // apply.workable.com/{account}[/j/{shortcode}] — "api" isn't an account
    const account = segments[0] === 'api' ? null : (segments[0] ?? null);
    return { provider: 'WORKABLE', identifier: account };
  }
  if (host.endsWith('.workable.com') && host !== 'www.workable.com') {
    return { provider: 'WORKABLE', identifier: host.split('.')[0] };
  }
  if (host.endsWith('.breezy.hr') && host !== 'app.breezy.hr' && host !== 'www.breezy.hr') {
    return { provider: 'BREEZY', identifier: host.split('.')[0] };
  }
  if (host.endsWith('.keka.com') && !['www', 'app', 'cdn'].includes(host.split('.')[0])) {
    // Tenant from subdomain; the adapter resolves the org document id from
    // the careers page at crawl time (it's embedded in page content, not URL).
    return { provider: 'KEKA', identifier: host.split('.')[0] };
  }
  if (
    (host.endsWith('.darwinbox.in') || host.endsWith('.darwinbox.com')) &&
    !['www', 'app'].includes(host.split('.')[0])
  ) {
    return { provider: 'DARWINBOX', identifier: host.split('.')[0] };
  }
  if (host.endsWith('.zohorecruit.com') && host.split('.')[0] !== 'www') {
    return { provider: 'ZOHO_RECRUIT', identifier: host.split('.')[0] };
  }
  if (host.endsWith('.freshteam.com') && host.split('.')[0] !== 'www') {
    return { provider: 'FRESHTEAM', identifier: host.split('.')[0] };
  }
  return { provider: 'UNKNOWN', identifier: null };
}

/** ATS providers we have working crawl adapters for (workers/src/adapters).
 *  DARWINBOX/ZOHO_RECRUIT/FRESHTEAM are detected (companies get tagged) but
 *  not yet crawlable — Darwinbox needs the Playwright scraper route. */
export const CRAWLABLE_PROVIDERS: AtsProviderName[] = [
  'GREENHOUSE',
  'LEVER',
  'ASHBY',
  'WORKABLE',
  'SMARTRECRUITERS',
  'RECRUITEE',
  'BREEZY',
  'KEKA',
  // Added 2026-08-22. The adapter shipped on 2026-08-20 and passed a nine-check
  // canary over 9 tenants, but was never listed here or in the workers' ADAPTERS
  // map — "built" is not "enabled". The full Bengaluru sweep then identified 8
  // Workday boards that could not be crawled by a component that already worked.
  'WORKDAY',
];
