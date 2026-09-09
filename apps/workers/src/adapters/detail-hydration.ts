import { MIN_DESCRIPTION_CHARS } from '@careeros/shared';

/**
 * Detail-page hydration — the decision logic, separated from the fetching so it
 * can be tested without a network.
 *
 * WHY THIS EXISTS (measured 2026-09-09). 82 career-page jobs sat at
 * INSUFFICIENT_EVIDENCE, every one of them with a valid per-job detail URL that
 * nothing ever fetched. Their stored "description" was a synthesised stub —
 * `${title} · ${location} — via ${company} careers page.`, 94 characters of the
 * title repeated back. Fetching those URLs over ordinary HTTP recovered a real
 * description for 77 of the 82, including 28 of 29 software roles.
 *
 * The rules below are refusals, not extraction cleverness. Each one exists
 * because the opposite behaviour is a way to corrupt the corpus silently:
 *
 *   NEVER FABRICATE      a description is either recovered or it is not. The
 *                        synthesised stub is exactly the bug being fixed;
 *                        writing another one would repeat it.
 *   NEVER WEAKEN         a shorter body must not replace a longer one. Detail
 *                        pages behind a login or a soft-404 return chrome, and
 *                        overwriting good evidence with it is unrecoverable.
 *   NEVER GUESS ABSENCE  a fetch failure is not evidence the job has no
 *                        description. It stays untouched and is retried; only a
 *                        page we actually read can justify MISSING.
 *   NEVER CLAIM DETAIL   descriptionSource DETAIL asserts we read the posting's
 *                        own page. It is set only when that is true.
 */

/** Phrases a real posting uses and a marketing page generally does not. */
const JD_MARKERS =
  /(responsibilit|requirement|qualification|what you'?ll do|what you will do|about the role|who you are|your role|we are looking for|you will|experience with|nice to have|preferred|minimum qualif|job description|about the job)/gi;

/**
 * Body text with obvious page chrome removed.
 *
 * Deliberately conservative: nav/header/footer go, everything else stays. A
 * cleverer main-content heuristic would be another thing to be silently wrong
 * about, and the threshold below is what actually decides usability.
 */
export function detailText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function jdMarkerCount(text: string): number {
  return (text.match(JD_MARKERS) ?? []).length;
}

/**
 * Is this text a job description, rather than a page that merely mentions jobs?
 *
 * Length alone is not enough — a marketing homepage clears 200 characters
 * easily. At least one posting phrase must be present as well.
 */
export function isJobDescription(text: string): boolean {
  return text.length >= MIN_DESCRIPTION_CHARS && jdMarkerCount(text) >= 1;
}

export type HydrationAction =
  | { action: 'WRITE'; description: string; descriptionSource: 'DETAIL'; reason: string }
  | { action: 'KEEP'; reason: string };

export interface CurrentJob {
  description: string | null;
  descriptionSource: 'LIST' | 'DETAIL' | 'MISSING' | null;
}

/**
 * What to do with a detail page for a job whose description is insufficient.
 *
 * Returns KEEP far more often than WRITE, and that is the point: the only
 * outcome that changes stored data is one where a real posting body was read.
 */
export function decideHydration(current: CurrentJob, fetchedHtml: string | null): HydrationAction {
  // A failed fetch is an absence of evidence, not evidence of absence. Marking
  // the job MISSING here would convert a timeout into a permanent verdict.
  if (fetchedHtml === null) {
    return { action: 'KEEP', reason: 'fetch failed — no page was read, nothing may be concluded' };
  }

  const text = detailText(fetchedHtml);
  const existing = current.description ?? '';

  if (!isJobDescription(text)) {
    return {
      action: 'KEEP',
      reason:
        text.length < MIN_DESCRIPTION_CHARS
          ? `detail page carried ${text.length} chars — still below ${MIN_DESCRIPTION_CHARS}`
          : `detail page carried ${text.length} chars but no posting phrases — not a job description`,
    };
  }

  // Never trade a longer body for a shorter one. A login wall or soft-404 can
  // clear the checks above while carrying less than what is already stored.
  if (text.length <= existing.length) {
    return {
      action: 'KEEP',
      reason: `detail page (${text.length}) is not richer than the stored body (${existing.length})`,
    };
  }

  return {
    action: 'WRITE',
    description: text,
    descriptionSource: 'DETAIL',
    reason: `recovered ${text.length} chars with ${jdMarkerCount(text)} posting phrase(s)`,
  };
}

/**
 * Is this job worth fetching at all?
 *
 * An absolute http(s) URL is required — a relative or missing one gives nowhere
 * to go — and a body that already clears the gate needs no help.
 */
export function needsHydration(job: { description: string | null; url: string | null }): boolean {
  if (!job.url || !/^https?:\/\//i.test(job.url)) return false;
  return (job.description ?? '').length < MIN_DESCRIPTION_CHARS;
}
