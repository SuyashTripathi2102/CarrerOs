import type { NormalizedJob } from '@careeros/shared';
import { htmlToText } from './html';
import { AtsAdapter, capDescription, fetchJson, workModeFromText } from './types';

interface LeverPosting {
  id: string;
  text: string; // title
  hostedUrl: string;
  createdAt?: number; // epoch ms
  country?: string;
  workplaceType?: 'remote' | 'hybrid' | 'on-site' | 'unspecified';
  // Lever splits a posting across SEVERAL body fields and not every tenant
  // populates the same ones. See buildDescription for why this matters.
  descriptionPlain?: string;
  description?: string; // HTML
  descriptionBodyPlain?: string;
  descriptionBody?: string; // HTML
  openingPlain?: string;
  opening?: string; // HTML
  additionalPlain?: string;
  additional?: string; // HTML
  categories?: { location?: string; commitment?: string; team?: string };
  salaryRange?: { min?: number; max?: number; currency?: string };
}

/**
 * Assemble the posting body from whichever fields the tenant actually fills.
 *
 * This adapter read `descriptionPlain` alone. Measured 2026-08-23: the
 * jobgether tenant returns `descriptionPlain: ""` while `description` carries
 * 1,574 characters of HTML — so 9,087 of its 9,401 postings were stored with an
 * EMPTY body, and the gate then refused them NOT_DEVELOPMENT for "no coding
 * responsibility stated". The content was in the payload we already downloaded
 * and threw away; no extra request was ever needed.
 *
 * Plain variants are preferred over HTML because they need no conversion; the
 * HTML twin is the fallback. Sections are joined because Lever genuinely splits
 * some postings into opening / body / additional, and any one alone is partial.
 */
export function buildDescription(p: LeverPosting): string {
  const section = (plain?: string, html?: string): string => {
    const t = (plain ?? '').trim();
    if (t) return t;
    const h = htmlToText(html ?? '').trim();
    return h;
  };
  return [
    section(p.openingPlain, p.opening),
    section(p.descriptionPlain, p.description) ||
      section(p.descriptionBodyPlain, p.descriptionBody),
    section(p.additionalPlain, p.additional),
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export const leverAdapter: AtsAdapter = {
  source: 'lever',

  async fetchJobs(site: string): Promise<NormalizedJob[]> {
    const postings = await fetchJson<LeverPosting[]>(
      `https://api.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`,
    );

    return postings.map((p) => {
      const body = buildDescription(p);
      return {
      externalId: p.id,
      title: p.text,
      description: capDescription(body),
      // Lever ships the body with the listing, so anything present is LIST.
      // Genuinely empty is MISSING — never '' passed off as a description.
      descriptionSource: (body ? 'LIST' : 'MISSING') as 'LIST' | 'MISSING',
      url: p.hostedUrl,
      location: p.categories?.location ?? null,
      country: p.country ?? null,
      workMode:
        p.workplaceType === 'remote'
          ? ('REMOTE' as const)
          : p.workplaceType === 'hybrid'
            ? ('HYBRID' as const)
            : p.workplaceType === 'on-site'
              ? ('ONSITE' as const)
              : workModeFromText(p.categories?.location),
      salaryMin: p.salaryRange?.min ?? null,
      salaryMax: p.salaryRange?.max ?? null,
      currency: p.salaryRange?.currency ?? null,
      postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      };
    });
  },
};
