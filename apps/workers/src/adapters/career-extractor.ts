import type { BoardJob } from '@careeros/shared';

/**
 * The extractor's version. Bump on ANY change that could extract new or
 * different jobs from the SAME HTML (new signal, relaxed gate, better candidate
 * generation). The replay queue re-runs this version over every stored snapshot
 * still behind it — turning a parser improvement into new jobs with no crawling.
 */
export const EXTRACTOR_VERSION = 'deterministic-v1';

/**
 * Deterministic career-page extractor (Tier 1 — no browser, no LLM).
 *
 * Modular by stage: preprocess → candidate generation → feature extraction →
 * classify with POSITIVE and NEGATIVE signals → explainable confidence + the
 * evidence for each field. Precision-first: it would rather emit nothing than a
 * certification exam or a "Executive Search" service page (the false positives
 * the earlier naive anchor-parser produced). Only jobs at/above the confidence
 * threshold are normalised to BoardJob; the rest fall through to later tiers
 * (Playwright render / LLM extraction).
 */

const ROLE =
  /\b(engineer|developer|sde|programmer|architect|analyst|designer|qa|tester|devops|sre|administrator|consultant|specialist|scientist|technician|lead|manager|intern|trainee|associate|executive|recruiter|full.?stack|back.?end|front.?end)\b/i;

// A "title" that is really a nav link, a service, a course, or a content page.
const NEGATIVE =
  /\b(certified|certification|certificate|exam|training|course|bootcamp|webinar|workshop|executive search|staff augmentation|\brpo\b|recruitment process|outsourc|consulting|advisory|case study|white ?paper|\bblog\b|about us|about|contact|privacy|cookie|partner|resources?|newsletter|ebook|guide|demo|pricing|login|log in|sign ?up|register|read more|learn more|view all|see all|apply now|home|careers?|jobs?|our team|culture|benefits|life at|why join)\b/i;

const CITY =
  /\b(bengaluru|bangalore|mumbai|pune|hyderabad|chennai|delhi|noida|gurgaon|gurugram|indore|kolkata|ahmedabad|jaipur|kochi|coimbatore|chandigarh|remote|hybrid)\b/i;
const EXPERIENCE = /\b\d{1,2}\s*[-–to]{1,3}\s*\d{1,2}\s*(?:\+?\s*)?(?:years?|yrs?)\b/i;
const EMPLOYMENT = /\b(full[\s-]?time|part[\s-]?time|contract|permanent|internship|freelance)\b/i;
const DEPARTMENT = /\b(engineering|technology|product|design|data|infrastructure|platform|backend|frontend|devops|qa)\b/i;
const SALARY = /(₹|\bINR\b|\bLPA\b|\$\s?\d|\d\s?(?:lpa|lakhs?))/i;
// Substring match (not \b): "/careers/react-developer" must count as a job URL.
const JOB_URL = /(job|career|position|opening|vacanc|apply|requisition|\/jd|\/p\/|posting)/i;

const clean = (s: string): string =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Stage 1 — strip only non-content noise. We deliberately KEEP nav/header/
 *  footer: real job links often live there ("Careers" / "Hire X"), and the
 *  NEGATIVE signal + role filter reject actual nav junk (Home/About/Contact).
 *  Exported so the snapshot pipeline stores this smaller fragment (not raw HTML)
 *  and replay re-extracts from the exact bytes the live run saw. */
export function preprocess(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

interface Candidate {
  title: string;
  href: string | null;
  context: string; // surrounding text, for location/experience signals
}

/** Stage 2 — candidate job blocks. List/row blocks FIRST so their richer context
 *  (location, experience) wins de-duplication over a bare anchor of the same title. */
function candidates(html: string): Candidate[] {
  const out: Candidate[] = [];
  // List/row candidates — <li>/<tr>: title is the first segment, context is the row.
  for (const m of html.matchAll(/<(li|tr)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const inner = m[2];
    const hrefM = inner.match(/href=["']([^"'#]+)["']/i);
    const text = clean(inner);
    const title = text.split(/·|—|\||,|\s{2,}/)[0]?.trim() || text;
    if (title) out.push({ title, href: hrefM?.[1] ?? null, context: text });
  }
  // Anchor candidates — title is the link text; href may be the apply URL.
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = clean(m[2]);
    if (title) out.push({ title, href: m[1], context: title });
  }
  return out;
}

export interface ExtractedJob {
  title: string;
  url: string | null;
  location: string | null;
  score: number; // 0–100 per-job confidence
  evidence: string[]; // which signals fired — explainable
}

export interface Extraction {
  jobs: ExtractedJob[]; // clean jobs at/above threshold
  confidence: number; // page-level 0–100
  reasons: string[]; // explainable page verdict
  boardJobs: BoardJob[];
}

/** Stage 3+4 — features + classification into an explainable score. */
function classify(c: Candidate, baseUrl: string): ExtractedJob | null {
  const title = c.title;
  const words = title.split(/\s+/);
  if (words.length < 2 || words.length > 9 || title.length < 4 || title.length > 90) return null;
  if (NEGATIVE.test(title)) return null; // reject certs/services/nav outright
  if (!ROLE.test(title)) return null; // a job title names a role

  const evidence: string[] = ['title'];
  let score = 45; // a role-shaped, non-negative title

  let url: string | null = null;
  if (c.href) {
    try {
      url = new URL(c.href, baseUrl).toString();
    } catch {
      url = null;
    }
  }
  if (url && JOB_URL.test(url)) {
    score += 25; // title + job-specific URL clears the default gate on its own
    evidence.push('job-url');
  } else if (url) {
    score += 8;
    evidence.push('link');
  }

  const loc = c.context.match(CITY)?.[0] ?? null;
  if (loc) {
    score += 12;
    evidence.push('location');
  }
  if (EXPERIENCE.test(c.context)) {
    score += 10;
    evidence.push('experience');
  }
  if (EMPLOYMENT.test(c.context)) {
    score += 8;
    evidence.push('employment-type');
  }
  if (DEPARTMENT.test(c.context)) {
    score += 6;
    evidence.push('department');
  }
  if (SALARY.test(c.context)) {
    score += 8;
    evidence.push('salary');
  }

  // A bare role title with NO supporting signal is probably prose, not a posting.
  if (evidence.length < 2) return null;

  return { title, url, location: loc, score: Math.min(100, score), evidence };
}

const externalIdFor = (url: string | null, title: string): string => {
  const basis = url ?? title;
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  return `careerpage-${h.toString(36)}`;
};

/**
 * Extract jobs from a career page's HTML. `threshold` (default 70) gates what
 * becomes a BoardJob — below it, the page is left for a later tier.
 */
export function extractCareerPage(
  html: string,
  baseUrl: string,
  companyName: string,
  threshold = 70,
): Extraction {
  const pre = preprocess(html);
  const seen = new Set<string>();
  const jobs: ExtractedJob[] = [];
  for (const c of candidates(pre)) {
    const job = classify(c, baseUrl);
    if (!job) continue;
    const key = job.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push(job);
  }
  jobs.sort((a, b) => b.score - a.score);

  const strong = jobs.filter((j) => j.score >= threshold && j.url);
  const avg = jobs.length ? Math.round(jobs.reduce((s, j) => s + j.score, 0) / jobs.length) : 0;
  const confidence = strong.length >= 3 ? Math.min(95, 60 + strong.length) : strong.length ? 55 : Math.min(45, avg);

  const reasons: string[] = [
    `${jobs.length} candidate title(s) survived filtering`,
    `${strong.length} at/above confidence ${threshold} with an apply URL`,
  ];

  const boardJobs: BoardJob[] = strong.map((j) => ({
    company: { name: companyName },
    job: {
      externalId: externalIdFor(j.url, j.title),
      title: j.title,
      description: `${j.title}${j.location ? ` · ${j.location}` : ''} — via ${companyName} careers page.`,
      url: j.url!,
      location: j.location,
      country: j.location && CITY.test(j.location) && !/remote|hybrid/i.test(j.location) ? 'IN' : null,
      workMode: /remote/i.test(j.location ?? '') ? 'REMOTE' : null,
    },
  }));

  return { jobs, confidence, reasons, boardJobs };
}
