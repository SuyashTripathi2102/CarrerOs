import { z } from 'zod';

/**
 * Cross-cutting enums referenced by both the resume/job-matching domain
 * (apps/api) and user-facing forms (apps/web) — kept here so the two never
 * drift out of sync.
 */

export const WorkModeSchema = z.enum(['REMOTE', 'HYBRID', 'ONSITE']);
export type WorkMode = z.infer<typeof WorkModeSchema>;

export const VisaSponsorshipSchema = z.enum(['REQUIRED', 'NOT_REQUIRED', 'OPEN_TO_EITHER']);
export type VisaSponsorship = z.infer<typeof VisaSponsorshipSchema>;

export const CompanySizeSchema = z.enum([
  'SEED_STARTUP',
  'EARLY_STAGE',
  'GROWTH',
  'MID_SIZE',
  'ENTERPRISE',
]);
export type CompanySize = z.infer<typeof CompanySizeSchema>;

export const ApplicationStatusSchema = z.enum([
  'SAVED',
  'APPLIED',
  'OA',
  'INTERVIEW',
  'OFFER',
  'REJECTED',
  'ACCEPTED',
  'WITHDRAWN',
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;
