import type { NormalizedJob } from '@jobintel/shared';
import { AtsAdapter, capDescription, fetchJson } from './types';

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  jobUrl: string;
  applyUrl?: string;
  isRemote?: boolean;
  isListed?: boolean;
  publishedAt?: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTierSummary?: string;
  };
}

export const ashbyAdapter: AtsAdapter = {
  source: 'ashby',

  async fetchJobs(boardName: string): Promise<NormalizedJob[]> {
    const data = await fetchJson<{ jobs: AshbyJob[] }>(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardName)}?includeCompensation=true`,
    );

    return (data.jobs ?? [])
      .filter((j) => j.isListed !== false)
      .map((j) => ({
        externalId: j.id,
        title: j.title,
        description: capDescription(
          [j.descriptionPlain ?? '', j.compensation?.compensationTierSummary ?? '']
            .filter(Boolean)
            .join('\n\n'),
        ),
        url: j.jobUrl,
        location: j.location ?? null,
        workMode: j.isRemote ? ('REMOTE' as const) : null,
        postedAt: j.publishedAt ?? null,
      }));
  },
};
