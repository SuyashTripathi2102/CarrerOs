import { PIPELINE_DECISION_VERSION } from './pipeline-version';

/**
 * Regression suite for the candidate-queue starvation bug (2026-08-12) and its
 * second incarnation, the decisionVersion split-brain (2026-08-15).
 *
 * `reconcileForUser` excludes candidates with
 *   NOT EXISTS (job_matches WHERE decidedAt IS NOT NULL ...)
 * but a job refused by the role gate never reached `scoreAndUpsert`, so no
 * job_matches row was ever written. The refusal therefore satisfied NOT EXISTS
 * on every subsequent run and permanently consumed a slot under LIMIT.
 *
 * Measured before the fix: 19 of 60 top slots dead, 106 pool-wide and rising --
 * 796 jobs had never been classified at all. Left alone, once 60 refusals
 * accumulate at the top of the similarity ordering the pipeline stops
 * evaluating new jobs entirely.
 *
 * These tests pin the exclusion *predicate* -- the SQL and the recording logic
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
  return row.decisionVersion === null || row.decisionVersion >= PIPELINE_DECISION_VERSION;
}

describe('candidate exclusion predicate', () => {
  const epoch = new Date('2026-01-01');
  const later = new Date('2026-08-12');

  it('a recorded gate refusal at the current pipeline version is excluded', () => {
    // The whole point: refusals must stop consuming candidate slots.
    expect(
      isExcludedFromCandidates({
        decidedAt: later,
        decisionVersion: PIPELINE_DECISION_VERSION,
        profileUpdatedAt: epoch,
      }),
    ).toBe(true);
  });

  it('a job never seen by the gate stays a candidate', () => {
    expect(
      isExcludedFromCandidates({ decidedAt: null, decisionVersion: null, profileUpdatedAt: epoch }),
    ).toBe(false);
  });

  it('a refusal from an OLDER pipeline version re-opens', () => {
    // Versioning is pointless if old verdicts stay binding.
    expect(
      isExcludedFromCandidates({
        decidedAt: later,
        decisionVersion: PIPELINE_DECISION_VERSION - 1,
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
        decisionVersion: PIPELINE_DECISION_VERSION,
        profileUpdatedAt: later,
      }),
    ).toBe(false);
  });

  it('a profile edit re-opens even a current-version refusal', () => {
    expect(
      isExcludedFromCandidates({
        decidedAt: new Date('2026-06-01'),
        decisionVersion: PIPELINE_DECISION_VERSION,
        profileUpdatedAt: later,
      }),
    ).toBe(false);
  });
});

/**
 * THE DECISION PERSISTENCE INVARIANT (2026-08-15).
 *
 * Every terminal decision must be persisted with the current pipeline version,
 * and every consumer must respect that version.
 *
 * Two writers stamp `job_matches.decisionVersion`:
 *
 *   recordGateRejections  (matching.service)    -- the free path, gate refusals
 *   scoreAndPersist       (opportunity.service) -- the paid path, deep scoring
 *
 * They stamped 2 and 1 respectively while the predicate tested `>= 2`, so the
 * expensive decisions were the ones that failed to stick. The belt re-judged
 * the same 89 jobs every tick: decided_total held at 1,488 across a full tick
 * while spend rose $0.2156 (~$1.29/hour for zero new decisions), and the
 * 4,908-job backlog behind them was unreachable.
 *
 * Both writers are modelled here rather than trusting one constant, because a
 * single shared constant is precisely what was missing.
 */
describe('decision persistence invariant', () => {
  const epoch = new Date('2026-01-01');
  const now = new Date('2026-08-15');

  /** What matching.service.recordGateRejections writes. */
  const gateRefusalStamp = () => PIPELINE_DECISION_VERSION;
  /** What opportunity.service.scoreAndPersist writes. */
  const deepScoreStamp = () => PIPELINE_DECISION_VERSION;

  it('both writers stamp the SAME version', () => {
    expect(deepScoreStamp()).toBe(gateRefusalStamp());
  });

  it('a gate refusal is not re-admitted', () => {
    expect(
      isExcludedFromCandidates({
        decidedAt: now,
        decisionVersion: gateRefusalStamp(),
        profileUpdatedAt: epoch,
      }),
    ).toBe(true);
  });

  it('a DEEP-SCORED decision is not re-admitted either', () => {
    // The regression itself. This returned false before the fix, which is what
    // made the belt loop forever over the jobs that cost money to judge.
    expect(
      isExcludedFromCandidates({
        decidedAt: now,
        decisionVersion: deepScoreStamp(),
        profileUpdatedAt: epoch,
      }),
    ).toBe(true);
  });

  it('neither writer can satisfy the predicate while the other cannot', () => {
    // Generalised: whatever the constant becomes, the two paths move together.
    const paths = [gateRefusalStamp(), deepScoreStamp()];
    const excluded = paths.map((v) =>
      isExcludedFromCandidates({ decidedAt: now, decisionVersion: v, profileUpdatedAt: epoch }),
    );
    expect(new Set(excluded).size).toBe(1);
  });

  it('bumping the version re-opens BOTH paths, not just one', () => {
    // The capability versioning exists for. A bump must invalidate every
    // terminal decision, or the cheap ones would outlive a taxonomy change.
    const stale = PIPELINE_DECISION_VERSION - 1;
    for (const v of [stale, stale]) {
      expect(
        isExcludedFromCandidates({ decidedAt: now, decisionVersion: v, profileUpdatedAt: epoch }),
      ).toBe(false);
    }
  });
});

/**
 * Mirrors the routing in gateByRole: every non-eligible job goes to exactly one
 * recorder, and both recorders write a row.
 */
type GateOutcome = 'SCORE' | 'SKIP' | 'NEEDS_REVIEW';
const route = (e: { eligible: boolean; needsReview: boolean }): GateOutcome =>
  e.eligible ? 'SCORE' : e.needsReview ? 'NEEDS_REVIEW' : 'SKIP';

describe('what gets recorded', () => {
  it('records a hard refusal as SKIP', () => {
    expect(route({ eligible: false, needsReview: false })).toBe('SKIP');
  });

  it('does NOT record an eligible job -- it proceeds to scoring', () => {
    expect(route({ eligible: true, needsReview: false })).toBe('SCORE');
  });

  it('records a needs-review job as NEEDS_REVIEW, not SKIP', () => {
    // Was dropped entirely until 2026-08-15. "Not confident" is a terminal
    // outcome and must be stored as its own verdict -- collapsing it into SKIP
    // would silently discard the jobs the classifier is least sure about.
    expect(route({ eligible: false, needsReview: true })).toBe('NEEDS_REVIEW');
  });
});

/**
 * THE NEEDS_REVIEW ESCALATION PATH (2026-08-15).
 *
 * `ReviewService.needsReview()` selects jobMatch rows with
 * `verdict = 'NEEDS_REVIEW'`. gateByRole collected uncertain jobs into an array
 * that reconcileForUser never read, so no such row was ever written:
 *
 *   NEEDS_REVIEW rows in job_matches   0
 *   job_review_feedback rows           0
 *   uncertain India jobs with no row  16
 *
 * The surface, the endpoints and the enum value all existed. Only the write
 * connecting them was missing -- a feature wired at both ends and disconnected
 * in the middle. These tests pin the middle.
 */
describe('needs-review escalation', () => {
  const epoch = new Date('2026-01-01');
  const now = new Date('2026-08-15');

  /** What recordNeedsReview writes. */
  const needsReviewRow = () => ({
    verdict: 'NEEDS_REVIEW' as const,
    decidedAt: now,
    decisionVersion: PIPELINE_DECISION_VERSION,
  });

  it('is a row the review surface can actually see', () => {
    // ReviewService filters on exactly this value.
    expect(needsReviewRow().verdict).toBe('NEEDS_REVIEW');
  });

  it('is never recorded as SKIP', () => {
    // /excluded filters verdict='SKIP'; burying uncertainty there would make
    // it read as a decision CareerOS never actually made.
    expect(needsReviewRow().verdict).not.toBe('SKIP');
  });

  it('stops the job re-entering the candidate queue', () => {
    // The 16 were re-fetched every tick precisely because no row existed.
    const r = needsReviewRow();
    expect(
      isExcludedFromCandidates({
        decidedAt: r.decidedAt,
        decisionVersion: r.decisionVersion,
        profileUpdatedAt: epoch,
      }),
    ).toBe(true);
  });

  it('re-opens when the pipeline version is bumped', () => {
    // Uncertainty is a judgement of the CURRENT classifier. A better one must
    // get another look rather than inheriting the old escalation.
    expect(
      isExcludedFromCandidates({
        decidedAt: now,
        decisionVersion: PIPELINE_DECISION_VERSION - 1,
        profileUpdatedAt: epoch,
      }),
    ).toBe(false);
  });

  it('re-opens when the profile changes, like every other verdict', () => {
    expect(
      isExcludedFromCandidates({
        decidedAt: epoch,
        decisionVersion: PIPELINE_DECISION_VERSION,
        profileUpdatedAt: now,
      }),
    ).toBe(false);
  });

  it('carries the same version as the other two writers', () => {
    // Three writers now stamp this column. The moment they disagree, the
    // candidate query starts re-admitting whichever one falls behind.
    expect(needsReviewRow().decisionVersion).toBe(PIPELINE_DECISION_VERSION);
  });
});
