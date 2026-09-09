import { createHash } from 'crypto';
import { MIN_DESCRIPTION_CHARS } from '@careeros/shared';

/**
 * Freshness semantics for a cached job classification.
 *
 * WHY THIS EXISTS (measured 2026-09-09). A description has three downstream
 * consumers, and until now only two of them noticed when it changed:
 *
 *   description changes
 *     -> embedding rebuilt         yes, ingest clears the vector
 *     -> decision re-opened        yes, since the evidence-invalidation clause
 *     -> classification recomputed NO
 *
 * `job_classifications` is cached per (jobId, classifierVersion) and was
 * upserted with `update: {}`, so it was written once and never revisited. When
 * a body arrived late the job was correctly re-admitted and then judged against
 * a classification whose own stored reasoning said "the job description is
 * completely empty" — for a posting now carrying 8,097 characters. The verdict
 * that came out was a confident NOT_DEVELOPMENT, which is exactly the claim the
 * INSUFFICIENT_EVIDENCE gate exists to prevent, and it is terminal: only
 * INSUFFICIENT_EVIDENCE re-opens, so such a job is never reconsidered.
 *
 * The invariant, which matters more than this implementation:
 *
 *   A classification may only be used for a job if it was computed against the
 *   job's current material evidence.
 */

/** Mirrors JD_CHARS in job-classifier.service — the slice the model actually reads. */
const CLASSIFIER_JD_CHARS = 6000;

/**
 * Fingerprint of exactly what the classifier consumes: the title and the
 * truncated description.
 *
 * Whitespace is normalised so that re-serialising the same posting does not
 * look like new evidence — a reformat is not a fact about the job. Anything
 * beyond CLASSIFIER_JD_CHARS is excluded because the model never saw it, and
 * pretending otherwise would invalidate classifications over text that could
 * not have influenced them.
 */
export function evidenceFingerprint(title: string, description: string): string {
  const normalised = `${(title ?? '').trim()}\n${(description ?? '').slice(0, CLASSIFIER_JD_CHARS)}`
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return createHash('sha256').update(normalised).digest('hex').slice(0, 32);
}

export interface CachedEvidence {
  evidenceFingerprint: string | null;
  evidenceLength: number | null;
}

/**
 * May this cached classification still be used?
 *
 * Deliberately narrow. A classification is only discarded when the job crossed
 * from unjudgeable to judgeable — from below MIN_DESCRIPTION_CHARS to at or
 * above it. That is the measured defect, and it bounds the cost: each
 * reclassification is roughly $0.019, and invalidating on every text change
 * would have re-run the whole 5,270-job description repair at about $100.
 *
 * PRE-EXISTING ROWS (null fingerprint) are treated as USABLE. They were written
 * before provenance was recorded, so nothing here can tell what they were
 * computed on, and guessing would either invalidate most of the corpus or
 * silently keep contaminated rows. The ~401 known-contaminated ones are a
 * separate, deliberate cleanup with its own evidence — not something to infer
 * from a missing column.
 */
export function isClassificationStale(
  cached: CachedEvidence,
  current: { title: string; description: string },
): boolean {
  // Unknown provenance: out of scope here, by design. See above.
  if (cached.evidenceFingerprint === null || cached.evidenceLength === null) return false;

  const currentFingerprint = evidenceFingerprint(current.title, current.description);
  if (currentFingerprint === cached.evidenceFingerprint) return false;

  // The evidence differs. Only a crossing of the judgeability threshold is
  // material enough to pay for a fresh classification.
  const wasInsufficient = cached.evidenceLength < MIN_DESCRIPTION_CHARS;
  const isSufficient = (current.description ?? '').length >= MIN_DESCRIPTION_CHARS;
  return wasInsufficient && isSufficient;
}

/** What to record alongside a classification so its freshness can be judged later. */
export function evidenceOf(job: { title: string; description: string }): {
  evidenceFingerprint: string;
  evidenceLength: number;
} {
  return {
    evidenceFingerprint: evidenceFingerprint(job.title, job.description),
    evidenceLength: (job.description ?? '').length,
  };
}
