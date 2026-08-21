import type { NormalizedJob } from '@careeros/shared';

/**
 * What a board walk saw, and whether it saw ALL of it.
 *
 * `complete: false` means the walk stopped short — a page cap, or a listing
 * request that failed mid-walk. The postings are still good; what is NOT good
 * is treating them as the whole board, because reconciliation retires every
 * ACTIVE job whose externalId is absent from the crawl.
 */
export interface BoardFetch {
  jobs: NormalizedJob[];
  complete: boolean;
  /** Why the walk stopped short. Present only when `complete` is false. */
  reason?: string;
}

/** One adapter per ATS: fetch a company's board and normalize it. */
export interface AtsAdapter {
  source: string;
  fetchJobs(identifier: string): Promise<NormalizedJob[]>;
  /**
   * OPTIONAL. An adapter that can walk off the end of a board implements this
   * so the pipeline learns the walk was partial. An adapter that always sees
   * the whole board (one request, no pagination) omits it and is treated as
   * complete — which is the truth for every adapter that has one.
   */
  fetchBoard?(identifier: string): Promise<BoardFetch>;
}

const USER_AGENT = 'CareerOS/0.1 (personal job-search agent)';

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Detect work mode from a location/title string — shared heuristic. */
export function workModeFromText(text: string | undefined | null): 'REMOTE' | 'HYBRID' | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes('remote')) return 'REMOTE';
  if (t.includes('hybrid')) return 'HYBRID';
  return null;
}

/** Descriptions can be enormous; cap to keep sync payloads sane. */
export function capDescription(text: string, max = 30_000): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[truncated]` : text;
}
