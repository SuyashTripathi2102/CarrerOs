import type { NormalizedJob } from '@careeros/shared';
import { htmlToText } from './html';
import { AtsAdapter, capDescription, fetchJson, workModeFromText } from './types';

/**
 * Breezy's `/json` listing carries NO description field at all — not an empty
 * one, absent. Measured 2026-08-23 against a live tenant: the keys are
 * id, friendly_id, name, url, published_date, type, location, department,
 * salary, company, locations.
 *
 * So `p.description ?? ''` produced an empty body for 100% of postings —
 * 2,914 of 2,914 ACTIVE Breezy jobs — and the gate refused them
 * NOT_DEVELOPMENT for "no coding responsibility stated". Breezy's measured
 * 0.2% actionable rate was never about job quality; nobody could read them.
 *
 * The posting's own page carries schema.org JobPosting (verified: 8,609 chars
 * of description), so hydration is a deterministic ld+json parse — no HTML
 * heuristics, no LLM, per the extraction tier order.
 */
const DETAIL_CONCURRENCY = 3;
const DETAIL_TIMEOUT_MS = 15_000;

/** Pull the JobPosting description out of a detail page's ld+json. */
export function descriptionFromJobPostingLd(html: string): string | null {
  for (const m of html.matchAll(
    /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue; // malformed ld+json is common; try the next block
    }
    const root = parsed as Record<string, unknown>;
    const nodes = Array.isArray(parsed)
      ? (parsed as Record<string, unknown>[])
      : [root, ...((root['@graph'] as Record<string, unknown>[]) ?? [])];
    for (const n of nodes) {
      if (n && n['@type'] === 'JobPosting' && typeof n.description === 'string') {
        const text = htmlToText(n.description).trim();
        if (text) return text;
      }
    }
  }
  return null;
}

async function fetchText(url: string): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DETAIL_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': 'CareerOS/0.1 (personal job-search agent)' },
      signal: ctl.signal,
    });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded fan-out. Keeps a large board from bursting the host. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

interface BreezyPosition {
  id: string;
  friendly_id?: string;
  name: string;
  description?: string; // HTML
  url?: string;
  published_date?: string;
  location?: {
    name?: string;
    city?: string;
    country?: { name?: string; id?: string };
    is_remote?: boolean;
  };
}

export const breezyAdapter: AtsAdapter = {
  source: 'breezy',

  async fetchJobs(companySlug: string): Promise<NormalizedJob[]> {
    const positions = await fetchJson<BreezyPosition[]>(
      `https://${encodeURIComponent(companySlug)}.breezy.hr/json`,
    );

    const rows = (positions ?? []).map((p) => ({
      p,
      url: p.url ?? `https://${companySlug}.breezy.hr/p/${p.friendly_id ?? p.id}`,
    }));

    // Hydrate ONLY what the listing did not provide. Today that is every row,
    // but the condition stays so a future Breezy change that starts including
    // the body costs no requests at all.
    const bodies = await mapLimit(rows, DETAIL_CONCURRENCY, async ({ p, url }) => {
      const fromList = htmlToText(p.description ?? '').trim();
      if (fromList) return { text: fromList, source: 'LIST' as const };
      const html = await fetchText(url);
      const text = html ? descriptionFromJobPostingLd(html) : null;
      // MISSING means SOUGHT AND UNAVAILABLE — the detail page was fetched and
      // carried no JobPosting. The gate holds these instead of judging them.
      return text
        ? { text, source: 'DETAIL' as const }
        : { text: '', source: 'MISSING' as const };
    });

    return rows.map(({ p, url }, i) => ({
      externalId: p.id,
      title: p.name,
      description: capDescription(bodies[i].text),
      descriptionSource: bodies[i].source,
      url,
      location: p.location?.name ?? p.location?.city ?? null,
      country: p.location?.country?.id ?? null,
      workMode: p.location?.is_remote
        ? ('REMOTE' as const)
        : workModeFromText(p.location?.name),
      postedAt: p.published_date ?? null,
    }));
  },
};
