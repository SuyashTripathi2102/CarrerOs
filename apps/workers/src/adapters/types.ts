import type { NormalizedJob } from '@jobintel/shared';

/** One adapter per ATS: fetch a company's board and normalize it. */
export interface AtsAdapter {
  source: string;
  fetchJobs(identifier: string): Promise<NormalizedJob[]>;
}

const USER_AGENT = 'JobIntel/0.1 (personal job-search agent)';

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
