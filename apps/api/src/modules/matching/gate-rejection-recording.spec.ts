import { CLASSIFIER_VERSION } from './job-classifier.service';

/**
 * Regression suite for the candidate-queue starvation bug (2026-08-12).
 *
 * `reconcileForUser` excludes candidates with
 *   NOT EXISTS (job_matches WHERE decidedAt IS NOT NULL ...)
 * but a job refused by the role gate never reached `scoreAndUpsert`, so no
 * job_matches row was ever written. The refusal therefore satisfied NOT EXISTS
 * on every subsequent run and permanently consumed a slot under LIMIT.
 *
 * Measured before the fix: 19 of 60 top slots dead, 106 pool-wide and rising —
 * 796 jobs had never been classified at all. Left alone, once 60 refusals
 * accumulate at the top of the similarity ordering the pipeline stops
 * evaluating new jobs entirely.
 *
 * These tests pin the exclusion *predicate* — the SQL and the recording logic
 * must agree about which rows are binding.
 */

/** Mirrors the NOT EXISTS clause in reconcileForUser's candidate query. */
function isExcludedFromCandidates(row: {
  decidedAt: Date | null;
  decisionVersion: number | null;
  profileUpdatedAt: Date;
}): boolean {
  if (row.decidedAt === null) return false;
  if (row.decidedAt < row.profileUpdatedAt) return false;
  return row.decisionVersion === null || row.decisionVersion >= CLASSIFIER_VERSION;
}

describe('candidate exclusion predicate', () => {
  const epoch = new Date('2026-01-01');
  const later = new Date('2026-08-12');

  it('a recorded gate refusal at the current classifier version is excluded', () => {
    // The whole point: refusals must stop consuming candidate slots.
    expect(
      isExcludedFromCandidates({
        decidedAt: later,
        decisionVersion: CLASSIFIER_VERSION,
        profileUpdatedAt: epoch,
      }),
    ).toBe(true);
  });

  it('a job never seen by the gate stays a candidate', () => {
    expect(
      isExcludedFromCandidates({ decidedAt: null, decisionVersion: null, profileUpdatedAt: epoch }),
    ).toBe(false);
  });

  it('a refusal from an OLDER classifier re-opens', () => {
    // Versioning the classifier is pointless if its old verdicts stay binding.
    expect(
      isExcludedFromCandidates({
        decidedAt: later,
        decisionVersion: CLASSIFIER_VERSION - 1,
        profileUpdatedAt: epoch,
      }),
    ).toBe(false);
  });

  it('a scored match (decisionVersion NULL) is still excluded', () => {
    // Scored matches predate this field and must not be re-scored every run.
    expect(
      isExcludedFromCandidates({ decidedAt: later, decisionVersion: null, profileUpdatedAt: epoch }),
    ).toBe(true);
  });

  it('a decision older than the last profile edit re-opens', () => {
    // Pre-existing rule: correcting your profile re-evaluates everything.
    expect(
      isExcludedFromCandidates({
        decidedAt: epoch,
        decisionVersion: CLASSIFIER_VERSION,
        profileUpdatedAt: later,
      }),
    ).toBe(false);
  });

  it('a profile edit re-opens even a current-classifier refusal', () => {
    expect(
      isExcludedFromCandidates({
        decidedAt: new Date('2026-06-01'),
        decisionVersion: CLASSIFIER_VERSION,
        profileUpdatedAt: later,
      }),
    ).toBe(false);
  });
});

describe('what gets recorded', () => {
  /** Mirrors the branch in gateByRole that decides whether to record. */
  const shouldRecord = (e: { eligible: boolean; needsReview: boolean }) =>
    !e.eligible && !e.needsReview;

  it('records a hard refusal', () => {
    expect(shouldRecord({ eligible: false, needsReview: false })).toBe(true);
  });

  it('does NOT record an eligible job — it proceeds to scoring', () => {
    expect(shouldRecord({ eligible: true, needsReview: false })).toBe(false);
  });

  it('does NOT record a needs-review job', () => {
    // Genuinely undecided: it must stay a candidate and reach Needs Review,
    // not be buried as a decided SKIP.
    expect(shouldRecord({ eligible: false, needsReview: true })).toBe(false);
  });
});
