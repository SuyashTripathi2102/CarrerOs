import type { AtsDetection, DiscoveryResult } from '@careeros/shared';
import { detectAts } from '@careeros/shared';

const UA = 'CareerOS/0.1 (personal job-search agent)';
const FETCH_TIMEOUT_MS = 12_000;

/** Common career-page paths, ordered by hit rate. Probed politely (~6 max). */
const CAREER_PATHS = ['/careers', '/jobs', '/careers/jobs', '/join', '/company/careers', '/about/careers'];

/** Careers-related URL shapes, matched in either an anchor href or a frame src. */
const CAREER_URL_PATTERN =
  '(?:career|careers|jobs|join-us|joinus|work-with-us|hiring|greenhouse\\.io|lever\\.co|ashbyhq\\.com|myworkdayjobs\\.com|recruitee\\.com|teamtailor\\.com|smartrecruiters\\.com)';

/** Anchor-href patterns that mark a link as careers-related. */
const CAREER_LINK_RE = new RegExp(`href=["']([^"']*${CAREER_URL_PATTERN}[^"']*)["']`, 'gi');

/**
 * The same shapes, but in an <iframe>/<frame> src.
 *
 * A board is as often EMBEDDED as linked. This file's own comment below has
 * always said boards are "usually embedded or linked from it" while the code
 * only ever read hrefs. Measured 2026-08-21 across 50 Bangalore companies:
 * Jupiter serves a Keka board — an ATS CareerOS already crawls — entirely
 * inside an iframe. It was invisible to the prober and would have been filed
 * UNKNOWN: a company we can crawl today, recorded as one we cannot.
 */
const CAREER_FRAME_RE = new RegExp(
  `<i?frame\\b[^>]*src=["']([^"']*${CAREER_URL_PATTERN}[^"']*)["']`,
  'gi',
);

export interface ProbeInput {
  name: string;
  website?: string | null;
  careerPageUrl?: string | null;
}

/**
 * The conversion engine: takes whatever we know about a company (sometimes
 * just a name) and works the lifecycle — verify website → scan homepage →
 * probe common paths → follow redirects → guess ATS tokens from the name.
 * Every request is labeled with our UA; total requests per company ≤ ~12.
 */
export async function probeCompany(input: ProbeInput): Promise<DiscoveryResult> {
  const log: string[] = [];
  let website = input.website ?? null;
  let websiteVerified = false;
  let careerPageUrl: string | null = null;
  let ats: AtsDetection = { provider: 'UNKNOWN', identifier: null };
  let metadata: {
    title?: string | null;
    description?: string | null;
    githubOrg?: string | null;
    blogUrl?: string | null;
  } | null = null;

  // 0. If we already hold a career/board hint, resolve it first (follows
  //    redirects — this converts RemoteOK-style redirect links into real ATS).
  if (input.careerPageUrl) {
    const resolved = await resolveUrl(input.careerPageUrl, log);
    if (resolved) {
      const detected = detectAts(resolved);
      if (detected.identifier) {
        ats = detected;
        careerPageUrl = resolved;
        log.push(`ATS from hint redirect: ${detected.provider}/${detected.identifier}`);
      }
    }
  }

  // 1. Verify website + harvest homepage metadata + scan for career links.
  if (website) {
    const page = await fetchPage(website, log);
    if (page) {
      websiteVerified = true;
      website = page.finalUrl;
      metadata = extractMetadata(page.html, page.finalUrl);

      if (!ats.identifier) {
        const links = extractCareerLinks(page.html, page.finalUrl);
        for (const link of links.slice(0, 4)) {
          const resolved = await resolveUrl(link, log);
          if (!resolved) continue;
          const detected = detectAts(resolved);
          if (detected.identifier) {
            ats = detected;
            careerPageUrl = resolved;
            log.push(`ATS from homepage link: ${detected.provider}/${detected.identifier}`);
            break;
          }
          if (!careerPageUrl && /career|job|join|hiring/i.test(resolved)) {
            careerPageUrl = resolved;
          }
        }
      }

      // 2. No career link on the homepage? Probe conventional paths.
      if (!ats.identifier && !careerPageUrl) {
        for (const path of CAREER_PATHS.slice(0, 4)) {
          const candidate = new URL(path, page.finalUrl).toString();
          const resolved = await resolveUrl(candidate, log, /* headOnly */ true);
          if (resolved) {
            careerPageUrl = resolved;
            const detected = detectAts(resolved);
            if (detected.identifier) {
              ats = detected;
              log.push(`ATS from path probe: ${detected.provider}/${detected.identifier}`);
            }
            break;
          }
        }
      }
    }
  }

  // 3. Career page found but ATS still unknown? Scan that page's HTML too —
  //    boards are usually embedded or linked from it.
  if (!ats.identifier && careerPageUrl) {
    const page = await fetchPage(careerPageUrl, log);
    if (page) {
      const links = extractCareerLinks(page.html, page.finalUrl);
      for (const link of links.slice(0, 4)) {
        const detected = detectAts(link);
        if (detected.identifier) {
          ats = detected;
          log.push(`ATS from career page: ${detected.provider}/${detected.identifier}`);
          break;
        }
      }
    }
  }

  // 4. Last resort: guess board tokens from the company name and probe the
  //    ATS APIs directly. Verification is free — a wrong guess 404s.
  if (!ats.identifier) {
    ats = await guessAtsToken(input.name, log);
  }

  return {
    websiteVerified,
    website: website ?? undefined,
    careerPageUrl: careerPageUrl ?? undefined,
    atsProvider: ats.identifier ? ats.provider : undefined,
    atsIdentifier: ats.identifier ?? undefined,
    metadata,
    probeLog: log.slice(0, 20),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function fetchPage(
  url: string,
  log: string[],
): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.push(`GET ${url} -> ${res.status}`);
      return null;
    }
    const html = (await res.text()).slice(0, 500_000);
    return { html, finalUrl: res.url || url };
  } catch (err) {
    log.push(`GET ${url} failed: ${err instanceof Error ? err.name : err}`);
    return null;
  }
}

/** Follow redirects; return the final URL if it resolves to a 2xx/3xx page. */
async function resolveUrl(url: string, log: string[], headOnly = false): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: headOnly ? 'HEAD' : 'GET',
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Some servers reject HEAD — retry small GET once.
    if (headOnly && res.status === 405) return resolveUrl(url, log, false);
    if (!res.ok) return null;
    return res.url || url;
  } catch {
    return null;
  }
}

/** Test seam: the extraction rules are worth pinning without a live probe. */
export const extractCareerLinksForTest = (html: string, baseUrl: string): string[] =>
  extractCareerLinks(html, baseUrl);

function extractCareerLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  // Frames FIRST. An embedded board IS the board; an anchor is often a nav item
  // pointing at another marketing page. Callers only probe the first few links,
  // so this ordering decides what actually gets checked.
  for (const re of [CAREER_FRAME_RE, CAREER_LINK_RE]) {
    for (const m of html.matchAll(re)) {
      try {
        const u = new URL(m[1], baseUrl);
        // http(s) only. A `data:`/`javascript:`/`mailto:` src resolves fine and
        // would consume one of the four probe slots on something that can never
        // be a board — sandboxed embeds legitimately use data: URIs.
        if (u.protocol === 'http:' || u.protocol === 'https:') out.add(u.toString());
      } catch {
        /* malformed href/src */
      }
    }
  }
  return [...out];
}

function extractMetadata(
  html: string,
  baseUrl: string,
): {
  title?: string | null;
  description?: string | null;
  githubOrg?: string | null;
  blogUrl?: string | null;
} {
  const title = html.match(/<title[^>]*>([^<]{1,200})/i)?.[1]?.trim() ?? null;
  const description =
    html
      .match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})["']/i)?.[1]
      ?.trim() ??
    html
      .match(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']description["']/i)?.[1]
      ?.trim() ??
    null;

  // Company Intelligence harvest: GitHub org + engineering blog, if linked.
  const githubOrg =
    html.match(/github\.com\/([a-zA-Z0-9][a-zA-Z0-9-]{1,38})(?:["'/?#]|$)/)?.[1] ?? null;
  const blogMatch = html.match(
    /href=["']([^"']*(?:engineering\.[^"']{2,80}|\/(?:blog|engineering)\/?))["']/i,
  )?.[1];
  let blogUrl: string | null = null;
  if (blogMatch) {
    try {
      blogUrl = new URL(blogMatch, baseUrl).toString(); // resolves relative /blog
    } catch {
      blogUrl = null;
    }
  }

  return {
    title,
    description,
    githubOrg: githubOrg && !RESERVED_GH.has(githubOrg.toLowerCase()) ? githubOrg : null,
    blogUrl,
  };
}

/** github.com/<these> are products/pages, not orgs. */
const RESERVED_GH = new Set([
  'features', 'pricing', 'about', 'contact', 'login', 'signup', 'sponsors',
  'marketplace', 'topics', 'collections', 'events', 'apps', 'orgs', 'enterprise',
]);

/**
 * Slug variants of a company name → probe each ATS's public API directly.
 * Ordered by ATS market share among tech companies. Each probe's body is
 * checked for a board-like shape — an ATS's generic 200 error page must not
 * count as a hit.
 */
async function guessAtsToken(name: string, log: string[]): Promise<AtsDetection> {
  const base = name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim();
  const slugs = [...new Set([base.replace(/\s+/g, ''), base.replace(/\s+/g, '-')])].filter(
    (s) => s.length >= 2,
  );

  for (const slug of slugs) {
    // Each validator PARSES the body and confirms an actual board. Marker/
    // substring checks are not enough: SmartRecruiters 200s with
    // totalFound:0 for ANY slug, and redirect landing pages can contain
    // anything. redirect:"manual" so a 3xx (Breezy's unknown-tenant answer)
    // never counts as success.
    const probes: {
      provider: AtsDetection['provider'];
      url: string;
      validate: (parsed: unknown) => boolean;
    }[] = [
      {
        provider: 'GREENHOUSE',
        url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
        validate: (p) => Array.isArray((p as { jobs?: unknown[] })?.jobs),
      },
      {
        provider: 'LEVER',
        url: `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`,
        validate: (p) => Array.isArray(p),
      },
      {
        provider: 'ASHBY',
        url: `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        validate: (p) => Array.isArray((p as { jobs?: unknown[] })?.jobs),
      },
      {
        provider: 'WORKABLE',
        url: `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
        // POSTINGS REQUIRED, like SmartRecruiters below — this endpoint 200s
        // with {jobs:[]} for ANY plausible company name, so an empty board is
        // not evidence of anything. Measured 2026-08-17 against the live API:
        //
        //   slug        greenhouse  lever  ashby  recruitee  workable  smartrec
        //   zensar         404       404    404     404      200 n=0   200 n=0
        //   kyndryl        404       404    404     404      200 n=0   200 n=0
        //   pepsico        404       404    404     404      200 n=0   200 n=0
        //   barclays       404       404    404     404      200 n=0   200 n=0
        //   qwzxnonsense   404       404    404     404      404       200 n=0
        //
        // Every other provider 404s for non-customers, so THEIR empty boards
        // are meaningful ("real customer, nothing open today") and still
        // validate. Only the two permissive endpoints demand postings.
        //
        // Cost of not doing this: 22 of 22 newly-probed companies were assigned
        // WORKABLE and every one crawled empty; historically 1,866 of 2,604
        // Workable runs (71.7%) found nothing. Before the reconciliation
        // guards, each of those wiped the company's jobs.
        // Array.isArray FIRST: a bare `.length > 0` is true for a string, so
        // a malformed payload like {jobs:"unavailable"} would confirm the
        // provider. Caught by the malformed-payload test.
        validate: (p) => {
          const jobs = (p as { jobs?: unknown })?.jobs;
          return Array.isArray(jobs) && jobs.length > 0;
        },
      },
      {
        provider: 'SMARTRECRUITERS',
        url: `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`,
        validate: (p) => ((p as { totalFound?: number })?.totalFound ?? 0) >= 1,
      },
      {
        provider: 'RECRUITEE',
        url: `https://${slug}.recruitee.com/api/offers/`,
        validate: (p) => Array.isArray((p as { offers?: unknown[] })?.offers),
      },
      {
        provider: 'BREEZY',
        url: `https://${slug}.breezy.hr/json`,
        validate: (p) => Array.isArray(p),
      },
    ];
    // A board that EXISTS is not the same as a board a company POSTS ON.
    // These validators accept `Array.isArray(payload.jobs)`, which is true for
    // `[]`, so the first provider holding an empty shell account won an
    // employer that hires elsewhere. Verified live 2026-08-16:
    //
    //   apply.workable.com/api/v1/widget/accounts/zensar   -> 200 {"jobs":[]}
    //   apply.workable.com/api/v1/widget/accounts/nonsense -> 404
    //
    // Zensar genuinely holds a Workable account; their postings are on Oracle.
    // Result: 169 companies labelled WORKABLE produced 1,172 zero-find crawls
    // of 1,426, and — before the reconciliation guards — each of those wiped
    // the company's jobs.
    //
    // So probes are no longer first-past-the-post. Every provider is tried, and
    // one with ACTUAL POSTINGS always beats one with an empty shell. An empty
    // board is still recorded (the company may simply not be hiring today) but
    // it only wins if nothing better exists.
    let emptyBoard: AtsDetection | null = null;

    for (const probe of probes) {
      try {
        const res = await fetch(probe.url, {
          headers: { 'user-agent': UA, accept: 'application/json' },
          redirect: 'manual',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.ok) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(await res.text());
          } catch {
            continue; // HTML/garbage — not a board
          }
          if (probe.validate(parsed)) {
            if (boardHasPostings(parsed)) {
              log.push(`ATS from token guess: ${probe.provider}/${slug} (has postings)`);
              return { provider: probe.provider, identifier: slug };
            }
            // Remember the first empty shell; keep probing for a live board.
            emptyBoard ??= { provider: probe.provider, identifier: slug };
          }
        }
      } catch {
        /* timeout/network — try next */
      }
    }

    if (emptyBoard) {
      log.push(
        `ATS from token guess: ${emptyBoard.provider}/${slug} (EMPTY board — exists but no postings)`,
      );
      return emptyBoard;
    }
  }
  return { provider: 'UNKNOWN', identifier: null };
}

/**
 * Does this probe payload contain actual postings?
 *
 * Deliberately separate from `validate`: validate answers "is this a board?",
 * this answers "is the company hiring HERE?". Conflating them is what let an
 * empty shell account outrank the ATS an employer actually posts on.
 */
export function boardHasPostings(parsed: unknown): boolean {
  if (Array.isArray(parsed)) return parsed.length > 0; // Lever, Breezy
  const p = parsed as { jobs?: unknown[]; offers?: unknown[]; totalFound?: number };
  if (Array.isArray(p?.jobs)) return p.jobs.length > 0; // Greenhouse, Ashby, Workable
  if (Array.isArray(p?.offers)) return p.offers.length > 0; // Recruitee
  if (typeof p?.totalFound === 'number') return p.totalFound > 0; // SmartRecruiters
  return false;
}
