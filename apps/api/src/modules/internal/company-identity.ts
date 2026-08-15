/**
 * Company identity (ADR-11). Names PROPOSE a match; ATS tenancy CONFIRMS it.
 *
 * Fingerprint dedup keys on `companyId`, so a company existing under two names
 * becomes two companies and its jobs, hiring velocity, referrals and outcomes
 * split between them. Measured 2026-08-15 in the live corpus: 7 alias groups
 * across 307 jobs, the worst being even splits (Zensar 11/11, JPMorganChase
 * 7/7) that halve every company-level signal. Projected onto a paginated
 * FreeHire sample: 33 groups, 530 jobs — 20%.
 *
 * The asymmetry that drives every rule here: under-merging costs a duplicate
 * row and is visible. OVER-merging silently fuses two companies' funding,
 * hiring velocity, contacts and outcomes, and is unrecoverable once downstream
 * signals are computed. When evidence is strong, automate; when it is not,
 * preserve the uncertainty. Same principle as UNKNOWN != LOW in scoring.
 */

/**
 * Hosts that carry jobs for arbitrary companies. These can NEVER confer
 * identity: treating an aggregator host as a tenant collapses every company it
 * touches into one. This list is the difference between a merge rule that is
 * safe at 9,000 jobs and one that quietly destroys the corpus.
 *
 * `remoteOK.com` is here because of a real row — `PAYTM SERVICES PVT LTD`
 * arrived through it while the real Paytm serves from jobs.lever.co/paytm.
 */
const AGGREGATOR_HOSTS = new Set([
  'echojobs.io',
  'remoteok.com',
  'remoteok.io',
  'himalayas.app',
  'jobstash.xyz',
  'whatjobs.com',
  'jooble.org',
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'monster.com',
  'naukri.com',
  'simplyhired.com',
  'jobgether.com',
  'weekday.works',
  'wellfound.com',
  'angel.co',
  'ycombinator.com',
  'freehire.me',
  't.me',
  'telegram.me',
  'google.com',
  'news.ycombinator.com',
]);

/**
 * Multi-tenant ATS hosts: the host is shared by every customer, so identity
 * lives in the FIRST PATH SEGMENT. `job-boards.greenhouse.io` alone would merge
 * hundreds of unrelated companies — GitLab and GitLab Inc. share it, but so
 * does everyone else on Greenhouse.
 */
const PATH_TENANT_HOSTS = new Set([
  'jobs.lever.co',
  'jobs.smartrecruiters.com',
  'careers.smartrecruiters.com',
  'apply.workable.com',
  'jobs.workable.com',
  'jobs.ashbyhq.com',
  'careers.jobscore.com',
  'jobs.jobvite.com',
  'recruiting.paylocity.com',
]);

/**
 * Any subdomain of these is multi-tenant. Enumerating exact hosts missed
 * `job-boards.eu.greenhouse.io`, which then fell through to FIRST_PARTY and
 * became one shared token across 6 unrelated companies — Bybit, Groww,
 * Moniepoint, Prolific, Currencies Direct and Redpin would have become
 * candidates for each other.
 */
const PATH_TENANT_SUFFIXES = ['.greenhouse.io', '.lever.co', '.smartrecruiters.com'];

/**
 * Path segments that are route literals, not tenants.
 *
 * Workable serves `apply.workable.com/j/<JOBID>` — `j` is a literal and what
 * follows is a JOB id, so the URL carries no company identity whatsoever.
 * Measured: 18 distinct companies shared the token `apply.workable.com/j`,
 * including Acely, CoverGo, Riot and Delta Exchange. Any name pair among them
 * would have reached STRONG on entirely false evidence.
 */
const NON_TENANT_SEGMENTS = new Set(['j', 'jobs', 'job', 'careers', 'career', 'search', 'apply', 'p']);

/** Hosts where the SUBDOMAIN is the tenant (acme.breezy.hr). */
const SUBDOMAIN_TENANT_SUFFIXES = [
  '.breezy.hr',
  '.recruitee.com',
  '.bamboohr.com',
  '.applytojob.com',
  '.freshteam.com',
  '.zohorecruit.com',
  '.factorialhr.com',
];

export type IdentityKind = 'PATH_TENANT' | 'SUBDOMAIN_TENANT' | 'FIRST_PARTY';

export interface IdentityToken {
  /** Stable, comparable identity string. */
  token: string;
  kind: IdentityKind;
}

const stripWww = (h: string): string => h.replace(/^www\./, '');

/** Registrable-ish host, enough to spot `linkedin.com` inside `www.linkedin.com`. */
function baseHost(host: string): string {
  const h = stripWww(host);
  const parts = h.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : h;
}

/**
 * Derive a company identity token from a job's apply URL.
 *
 * Returns null when the URL cannot identify a company — an aggregator, a
 * multi-tenant host with no path token, or an unparseable link. Null means
 * UNKNOWN, never "different company".
 *
 * The stored `companies.atsProvider` / `atsIdentifier` columns are deliberately
 * NOT used: `atsIdentifier` is derived from the company name (`zensar` vs
 * `zensar-technologies`), so it fragments identically to the thing it would be
 * disambiguating, and `atsProvider` is demonstrably wrong in places (HEXAWARE
 * is stored WORKABLE while serving from Oracle Cloud). The URL is ground truth.
 */
export function identityTokenFromUrl(rawUrl: string | null | undefined): IdentityToken | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = stripWww(url.hostname.toLowerCase());
  if (AGGREGATOR_HOSTS.has(host) || AGGREGATOR_HOSTS.has(baseHost(host))) return null;

  const isPathTenant =
    PATH_TENANT_HOSTS.has(host) || PATH_TENANT_SUFFIXES.some((s) => host.endsWith(s));
  if (isPathTenant) {
    const seg = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    // No segment, or a route literal rather than a tenant: the URL identifies
    // a job, not a company. Null = UNKNOWN, never "same company".
    if (!seg || NON_TENANT_SEGMENTS.has(seg)) return null;
    return { token: `${host}/${seg}`, kind: 'PATH_TENANT' };
  }

  for (const suffix of SUBDOMAIN_TENANT_SUFFIXES) {
    if (host.endsWith(suffix)) {
      const sub = host.slice(0, -suffix.length);
      if (!sub || sub.includes('.')) return null;
      return { token: host, kind: 'SUBDOMAIN_TENANT' };
    }
  }

  // First-party tenant: a Workday/Oracle/company-owned host.
  // motorolasolutions.wd5.myworkdayjobs.com and
  // fa-etvl-saasfaprod1.fa.ocs.oraclecloud.com are unique per customer.
  return { token: host, kind: 'FIRST_PARTY' };
}

/**
 * The proposal key is `companies/company-name.ts`, NOT a second normalizer.
 *
 * That module already strips trailing legal-entity suffixes plus
 * `technologies`/`technology`, which is exactly the tier that proposes
 * `Zensar` / `Zensar Technologies` and `HEXAWARE` / `Hexaware Technologies`
 * while leaving `Apple` / `Apple Bank` and `Motorola` / `Motorola Solutions`
 * apart — "Solutions" is descriptive and is deliberately never stripped.
 *
 * Defining a competing key here is the decisionVersion split-brain again: two
 * constants for one question, drifting apart until something silently
 * re-admits or over-merges. One key, one source of truth.
 */
export { normalizeCompanyName } from '../companies/company-name';
import { normalizeCompanyName as proposalKey } from '../companies/company-name';

export type IdentityConfidence = 'STRONG' | 'MEDIUM' | 'WEAK' | 'UNKNOWN';

export interface IdentityCandidate {
  name: string;
  /** Apply-URL derived token, or null when no reliable evidence exists. */
  token?: string | null;
  /** Canonical website domain, if known. */
  domain?: string | null;
}

/**
 * How confident are we that these two rows are the same company?
 *
 * Only STRONG may auto-merge. Everything else goes to review — including
 * "different tenant", which is NOT evidence of distinctness: companies run more
 * than one ATS, and one side may simply have arrived via an aggregator.
 */
export function identityConfidence(a: IdentityCandidate, b: IdentityCandidate): IdentityConfidence {
  // Names that do not even propose a match are not candidates at all.
  // `Apple` vs `Apple Bank` stops here and can never reach STRONG, whatever
  // tenancy says.
  if (proposalKey(a.name) !== proposalKey(b.name)) return 'UNKNOWN';

  if (a.token && b.token) {
    if (a.token === b.token) return 'STRONG';
    return 'UNKNOWN'; // differing tenants prove nothing either way
  }

  if (a.domain && b.domain && a.domain.toLowerCase() === b.domain.toLowerCase()) return 'MEDIUM';

  return 'WEAK';
}

/** Only STRONG automates. Everything else is escalated, never guessed. */
export function shouldAutoMerge(c: IdentityConfidence): boolean {
  return c === 'STRONG';
}
