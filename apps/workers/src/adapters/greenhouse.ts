import type { NormalizedJob } from '@careeros/shared';
import { decodeEntities, htmlToText } from './html';
import { AtsAdapter, capDescription, fetchJson, workModeFromText } from './types';

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  location?: { name?: string };
  content?: string; // HTML, double-entity-encoded
}

export const greenhouseAdapter: AtsAdapter = {
  source: 'greenhouse',

  async fetchJobs(boardToken: string): Promise<NormalizedJob[]> {
    const data = await fetchJson<{ jobs: GreenhouseJob[] }>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`,
    );

    return data.jobs.map((j) => ({
      externalId: String(j.id),
      title: j.title,
      description: capDescription(htmlToText(decodeEntities(j.content ?? ''))),
      url: j.absolute_url,
      location: j.location?.name ?? null,
      workMode: workModeFromText(j.location?.name),
      postedAt: j.first_published ?? j.updated_at ?? null,
    }));
  },
};
