import type { BoardJob } from '@careeros/shared';
import { decodeEntities, htmlToText } from './html';
import { capDescription, fetchJson } from './types';

interface RemoteOkItem {
  id?: string | number;
  slug?: string;
  company?: string;
  position?: string;
  description?: string; // HTML
  location?: string;
  salary_min?: number;
  salary_max?: number;
  url?: string;
  apply_url?: string;
  date?: string;
  legal?: string; // first array element is a legal notice, not a job
}

/**
 * Locations that are consistent with a remote-only board: absent entirely
 * (the common case), or an explicit remote/region scope.
 */
const REMOTE_SCOPE_RE =
  /^(remote|worldwide|anywhere|global|distributed|hybrid|emea|apac|latam|eu|uk|usa?|europe|north america|south america|asia|africa|oceania|americas)\b/i;

/** A malformed geo string: "Bedford, " — a locality whose second component
 *  never resolved. RemoteOK emits this shape for rows it scraped off a page
 *  rather than received as a posting. */
const TRUNCATED_GEO_RE = /,\s*$/;

/**
 * Does `location` contradict the premise of a remote-only board?
 * "Meat Department Manager — Bedford," is not a RemoteOK posting whatever
 * else it is.
 */
function locationContradictsRemote(location: string | undefined): boolean {
  const loc = (location ?? '').trim();
  if (!loc) return false; // absent -> adapter defaults to "Remote"
  if (TRUNCATED_GEO_RE.test(loc)) return true; // corrupt geo
  return !REMOTE_SCOPE_RE.test(loc); // a specific locality
}

/**
 * Structural test for "is this string a job title", with no vocabulary list:
 * a title is a short single-line noun phrase, not a heading, sentence,
 * question, or error string.
 */
function titleLacksJobShape(rawTitle: string): boolean {
  const title = rawTitle.trim();
  if (title.length < 3 || title.length > 120) return true;
  if (/[\r\n]/.test(title)) return true; // multi-line -> page fragment
  if (!/[a-z]/i.test(title)) return true; // no letters at all
  if (/[?!]/.test(title)) return true; // questions/exclamations aren't titles

  const words = title.split(/\s+/).filter(Boolean);
  if (words.length > 12) return true; // a sentence, not a title

  // SHOUTED HEADINGS ("HOW APPLY", "CURRENT JOBS OPENING"). A single
  // all-caps token is fine — acronyms like "SRE", "QA" are legitimate.
  const letters = title.replace(/[^a-z]/gi, '');
  if (words.length > 1 && letters.length > 0 && letters === letters.toUpperCase()) return true;

  return false;
}

/**
 * RemoteOK's feed carries rows its own crawler lifted off company pages —
 * error screens ("Oops something happened"), nav items ("Corporate"),
 * headings ("HOW APPLY"), and body copy ("Recognizing the Friction") — all
 * arriving with a valid id, company, and URL, so identity checks alone let
 * them through. They then cost an LLM classification each and pollute the
 * feed, so they are rejected here, deterministically, before ingestion.
 *
 * Exported for the regression suite.
 */
export function isPlausibleRemoteOkPosting(item: RemoteOkItem): boolean {
  if (!item.id || !item.position || !item.company) return false;
  if (locationContradictsRemote(item.location)) return false;
  if (titleLacksJobShape(String(item.position))) return false;
  return true;
}

/**
 * RemoteOK's public API (attribution required — we store and show the
 * original URL, which satisfies it). This is a *board* source: every item
 * names a company we may not know yet, and apply_url frequently points at
 * the company's own ATS — prime discovery-flywheel input.
 */
export async function fetchRemoteOkJobs(): Promise<BoardJob[]> {
  const items = await fetchJson<RemoteOkItem[]>('https://remoteok.com/api');

  return items
    .filter(isPlausibleRemoteOkPosting)
    .map((i) => ({
      company: {
        // RemoteOK names arrive HTML-encoded ("RG&amp;T Solutions") — decode
        // or the discovery prober guesses tokens from garbage.
        name: decodeEntities(i.company!),
        atsHintUrl: safeUrl(i.apply_url) ?? null,
      },
      job: {
        externalId: `remoteok-${i.id}`,
        title: decodeEntities(i.position!),
        description: capDescription(htmlToText(i.description ?? '')),
        url: safeUrl(i.url) ?? `https://remoteok.com/remote-jobs/${i.slug ?? i.id}`,
        location: i.location || 'Remote',
        workMode: 'REMOTE' as const,
        salaryMin: i.salary_min || null,
        salaryMax: i.salary_max || null,
        currency: i.salary_min ? 'USD' : null,
        postedAt: i.date ? new Date(i.date).toISOString() : null,
      },
    }));
}

function safeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    new URL(u);
    return u;
  } catch {
    return undefined;
  }
}
