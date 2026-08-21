/**
 * The canonical answer to "what counts as applied / reached interview".
 *
 * Extracted 2026-08-21 so the source→outcome funnel cannot invent a second
 * definition. Two divergent answers to one question is precisely the failure
 * the displayed-vs-stored score incident already cost us: a surface reporting
 * one number while the decision engine held another.
 */
import { ApplicationStatus } from '@prisma/client';

/**
 * Every status that implies an application was actually submitted. REJECTED
 * belongs here — a rejection is proof you applied, and excluding it would
 * inflate every downstream rate by shrinking the denominator.
 */
export const APPLIED_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.APPLIED,
  ApplicationStatus.OA,
  ApplicationStatus.INTERVIEW,
  ApplicationStatus.OFFER,
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.REJECTED,
];

/** Reached at least an interview. Status is furthest-progress, not a log. */
export const INTERVIEW_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.INTERVIEW,
  ApplicationStatus.OFFER,
  ApplicationStatus.ACCEPTED,
];

export const OFFER_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.OFFER,
  ApplicationStatus.ACCEPTED,
];

/**
 * Below this many applications a rate is noise, and is reported as null rather
 * than as a confident percentage. One interview from one application is not a
 * 100% interview rate — it is one data point wearing a percentage sign.
 */
export const MIN_APPLIED_FOR_RATE = 5;

const has = (set: ApplicationStatus[], s: string) => set.includes(s as ApplicationStatus);
export const isApplied = (s: string) => has(APPLIED_STATUSES, s);
export const isInterview = (s: string) => has(INTERVIEW_STATUSES, s);
export const isOffer = (s: string) => has(OFFER_STATUSES, s);
