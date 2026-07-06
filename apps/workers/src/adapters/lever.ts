import type { NormalizedJob } from '@careeros/shared';
import { AtsAdapter, capDescription, fetchJson, workModeFromText } from './types';

interface LeverPosting {
  id: string;
  text: string; // title
  hostedUrl: string;
  createdAt?: number; // epoch ms
  country?: string;
  workplaceType?: 'remote' | 'hybrid' | 'on-site' | 'unspecified';
  descriptionPlain?: string;
  categories?: { location?: string; commitment?: string; team?: string };
  salaryRange?: { min?: number; max?: number; currency?: string };
}

export const leverAdapter: AtsAdapter = {
  source: 'lever',

  async fetchJobs(site: string): Promise<NormalizedJob[]> {
    const postings = await fetchJson<LeverPosting[]>(
      `https://api.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`,
    );

    return postings.map((p) => ({
      externalId: p.id,
      title: p.text,
      description: capDescription(p.descriptionPlain ?? ''),
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
    }));
  },
};
