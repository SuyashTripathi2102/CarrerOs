import { z } from 'zod';
import { WorkModeSchema } from './enums';

/**
 * The contract every crawler adapter (Node ATS fetchers, Python scraper)
 * normalizes into before POSTing to the API's internal ingest endpoints.
 * Adapters own source quirks; everything downstream speaks only this shape.
 */
export const NormalizedJobSchema = z.object({
  externalId: z.string().min(1), // stable id from the source (ATS job id or canonical URL)
  title: z.string().min(1),
  description: z.string().default(''),
  url: z.string().url(), // the direct apply link
  location: z.string().nullish(),
  country: z.string().nullish(),
  workMode: WorkModeSchema.nullish(),
  salaryMin: z.number().int().nullish(),
  salaryMax: z.number().int().nullish(),
  currency: z.string().nullish(),
  // offset/local allowed: Greenhouse sends "2026-07-01T10:23:45-04:00"
  postedAt: z.iso.datetime({ offset: true, local: true }).nullish(),
  raw: z.unknown().optional(), // original payload, stored for reprocessing
});
export type NormalizedJob = z.infer<typeof NormalizedJobSchema>;

/** Board jobs (RemoteOK, HN...) also carry the company they belong to — flywheel input. */
export const BoardJobSchema = z.object({
  company: z.object({
    name: z.string().min(1),
    website: z.string().url().nullish(),
    /** Apply URL — the API detects the company's ATS from this and starts direct crawls. */
    atsHintUrl: z.string().url().nullish(),
  }),
  job: NormalizedJobSchema,
});
export type BoardJob = z.infer<typeof BoardJobSchema>;
