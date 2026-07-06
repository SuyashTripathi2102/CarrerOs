import { AtsProvider } from '@prisma/client';

export interface AtsDetection {
  provider: AtsProvider;
  identifier: string | null;
}

/**
 * Detects an ATS provider + board identifier from any URL pointing at a
 * hosted job board or a specific posting on one. This is what turns
 * "here's a job/career link" into "we can crawl this company forever" —
 * the discovery flywheel's key move.
 */
export function detectAts(url: string): AtsDetection {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { provider: AtsProvider.UNKNOWN, identifier: null };
  }
  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split('/').filter(Boolean);

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    // boards.greenhouse.io/{token}[/jobs/{id}] — "embed" pages put it in ?for=
    const token = segments[0] === 'embed' ? u.searchParams.get('for') : segments[0];
    return { provider: AtsProvider.GREENHOUSE, identifier: token ?? null };
  }
  if (host === 'jobs.lever.co') {
    return { provider: AtsProvider.LEVER, identifier: segments[0] ?? null };
  }
  if (host === 'jobs.ashbyhq.com') {
    return { provider: AtsProvider.ASHBY, identifier: segments[0] ?? null };
  }
  if (host.endsWith('.myworkdayjobs.com')) {
    // {tenant}.wd{N}.myworkdayjobs.com/{site} — needs both to build the CXS API URL
    const tenant = host.split('.')[0];
    const site = segments.find((s) => !['en-US', 'wday'].includes(s));
    return {
      provider: AtsProvider.WORKDAY,
      identifier: site ? `${tenant}/${site}` : tenant,
    };
  }
  if (host.endsWith('.recruitee.com')) {
    return { provider: AtsProvider.RECRUITEE, identifier: host.split('.')[0] };
  }
  if (host.endsWith('.teamtailor.com')) {
    return { provider: AtsProvider.TEAMTAILOR, identifier: host.split('.')[0] };
  }
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') {
    return { provider: AtsProvider.SMARTRECRUITERS, identifier: segments[0] ?? null };
  }
  return { provider: AtsProvider.UNKNOWN, identifier: null };
}
