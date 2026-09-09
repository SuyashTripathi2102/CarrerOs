import { readFileSync } from 'fs';
import { join } from 'path';
import { PIPELINE_DECISION_VERSION } from './pipeline-version';
import { MIN_DESCRIPTION_CHARS } from './role-classification';

/**
 * Regression suite for the stale-evidence decision (2026-09-09).
 *
 * A decision used to be re-opened by a new profile or a new pipeline version
 * and by NOTHING ELSE. The job's own content was not in the predicate, so a
 * body that arrived late could not un-stick the verdict made when there was
 * nothing to read.
 *
 * The asymmetry is what made it invisible: ingest DOES notice a changed body —
 * it clears the embedding so the vector is rebuilt — and the job then re-enters
 * retrieval looking perfectly healthy, only to be excluded here. Vector fresh,
 * verdict frozen.
 *
 * Measured before the fix: 26 rows held at INSUFFICIENT_EVIDENCE with
 * descriptions since grown to 1,496-3,851 characters, every one of them with an
 * embedding rebuilt AFTER its decision. They are the proof case below.
 */

/** Mirrors the NOT EXISTS clause in reconcileForUser's candidate query. */
function isExcludedFromCandidates(row: {
  decidedAt: Date | null;
  decisionVersion: number | null;
  profileUpdatedAt: Date;
  verdictCode: string | null;
  descriptionLength: number;
}): boolean {
  if (row.decidedAt === null) return false;
  if (row.decidedAt < row.profileUpdatedAt) return false;
  if (!(row.decisionVersion === null || row.decisionVersion >= PIPELINE_DECISION_VERSION)) return false;
  // Evidence invalidation: INSUFFICIENT_EVIDENCE records that the body was
  // below the threshold at decision time. If it no longer is, the decision
  // rested on evidence that does not exist any more.
  if (row.verdictCode === 'INSUFFICIENT_EVIDENCE' && row.descriptionLength >= MIN_DESCRIPTION_CHARS) {
    return false;
  }
  return true;
}

const BASE = {
  decidedAt: new Date('2026-09-01T00:00:00Z'),
  decisionVersion: PIPELINE_DECISION_VERSION,
  profileUpdatedAt: new Date('2026-08-01T00:00:00Z'),
  verdictCode: 'TARGET_ROLE_ELIGIBLE' as string | null,
  descriptionLength: 4000,
};

describe('evidence invalidation — the 26 stale rows', () => {
  it('RE-OPENS a job held at INSUFFICIENT_EVIDENCE whose body now clears the gate', () => {
    // The exact production shape: judged when the body was a 94-char synthetic
    // stub, hydrated later to thousands of characters, never looked at again.
    expect(
      isExcludedFromCandidates({
        ...BASE,
        verdictCode: 'INSUFFICIENT_EVIDENCE',
        descriptionLength: 3851,
      }),
    ).toBe(false);
  });

  it('keeps holding it while the body is still too thin', () => {
    // Re-opening a job that would only be refused again burns a candidate slot
    // on every tick — the queue-starvation shape.
    expect(
      isExcludedFromCandidates({
        ...BASE,
        verdictCode: 'INSUFFICIENT_EVIDENCE',
        descriptionLength: MIN_DESCRIPTION_CHARS - 1,
      }),
    ).toBe(true);
  });

  it('re-opens exactly at the threshold, not one character short', () => {
    expect(
      isExcludedFromCandidates({ ...BASE, verdictCode: 'INSUFFICIENT_EVIDENCE', descriptionLength: MIN_DESCRIPTION_CHARS }),
    ).toBe(false);
    expect(
      isExcludedFromCandidates({ ...BASE, verdictCode: 'INSUFFICIENT_EVIDENCE', descriptionLength: MIN_DESCRIPTION_CHARS - 1 }),
    ).toBe(true);
  });
});

describe('decisions reached by actually reading a posting stay binding', () => {
  /**
   * The scope of the rule matters as much as the rule. Re-opening on any
   * content change would re-judge the corpus every time a posting gained a
   * "posted 2 days ago" line, at ~$0.019 of classification each.
   */
  it.each([
    'NOT_DEVELOPMENT',
    'TARGET_ROLE_TOO_SENIOR',
    'DEVELOPMENT_WRONG_SPECIALIZATION',
    'CORE_STACK_MISMATCH',
    'SCORE_BELOW_BAR',
    'TARGET_ROLE_ELIGIBLE',
  ])('does NOT re-open %s even with a long description', (code) => {
    expect(isExcludedFromCandidates({ ...BASE, verdictCode: code, descriptionLength: 9000 })).toBe(true);
  });

  it('does not re-open a null verdictCode', () => {
    expect(isExcludedFromCandidates({ ...BASE, verdictCode: null, descriptionLength: 9000 })).toBe(true);
  });
});

describe('the pre-existing invalidation paths still work', () => {
  it('an undecided row is always a candidate', () => {
    expect(isExcludedFromCandidates({ ...BASE, decidedAt: null })).toBe(false);
  });

  it('a profile update re-opens everything', () => {
    expect(
      isExcludedFromCandidates({ ...BASE, profileUpdatedAt: new Date('2026-09-05T00:00:00Z') }),
    ).toBe(false);
  });

  it('a pipeline version bump re-opens everything', () => {
    expect(
      isExcludedFromCandidates({ ...BASE, decisionVersion: PIPELINE_DECISION_VERSION - 1 }),
    ).toBe(false);
  });
});

describe('the mirror above must not drift from the SQL', () => {
  /**
   * This suite tests a TypeScript restatement of a raw SQL predicate, which is
   * worth exactly nothing if the two diverge. The phase-0 collector drifted
   * from `browseByFit` this way and reported 3 surfaceable jobs against
   * production's 50 for five days.
   */
  const sql = readFileSync(join(__dirname, 'matching.service.ts'), 'utf8');

  it('the candidate query really contains the evidence-invalidation clause', () => {
    const notExists = sql.slice(sql.indexOf('AND NOT EXISTS ('));
    const clause = notExists.slice(0, notExists.indexOf('ORDER BY'));
    expect(clause).toMatch(/m\."verdictCode"\s*=\s*'INSUFFICIENT_EVIDENCE'/);
    expect(clause).toMatch(/length\(COALESCE\(j\.description, ''\)\)\s*>=\s*\$\{MIN_DESCRIPTION_CHARS\}/);
    expect(clause).toMatch(/AND NOT \(/);
  });

  it('uses the shared threshold constant rather than a literal 200', () => {
    // A hard-coded 200 here would be a third copy of the same business fact.
    const notExists = sql.slice(sql.indexOf('AND NOT EXISTS ('));
    const clause = notExists.slice(0, notExists.indexOf('ORDER BY'));
    expect(clause).not.toMatch(/>=\s*200\b/);
  });
});
