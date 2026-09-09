import { readFileSync } from 'fs';
import { join } from 'path';
import {
  evidenceFingerprint,
  evidenceOf,
  isClassificationStale,
} from './classification-evidence';
import { MIN_DESCRIPTION_CHARS } from './role-classification';

/**
 * Regression suite for the third evidence consumer (2026-09-09).
 *
 * A description feeds an embedding, a decision and a classification. The first
 * two noticed when it changed; the classification did not. So a job that gained
 * a real body was re-admitted and then judged against a classification whose
 * own stored reasoning read "the job description is completely empty" — for a
 * posting carrying 8,097 characters. The verdict was NOT_DEVELOPMENT: a
 * confident claim about a posting nobody read, and terminal, because only
 * INSUFFICIENT_EVIDENCE re-opens.
 *
 * The invariant these pin: a classification may only be used for a job if it
 * was computed against that job's current material evidence.
 */

const BODY = (n: number) => 'Responsibilities include building services. '.repeat(Math.ceil(n / 43)).slice(0, n);
const STUB = 'Backend Engineer · Bengaluru — via Acme careers page.';

describe('evidenceFingerprint', () => {
  it('is stable for the same evidence', () => {
    expect(evidenceFingerprint('Backend Engineer', BODY(500))).toBe(
      evidenceFingerprint('Backend Engineer', BODY(500)),
    );
  });

  it('changes when the description changes', () => {
    expect(evidenceFingerprint('Backend Engineer', STUB)).not.toBe(
      evidenceFingerprint('Backend Engineer', BODY(500)),
    );
  });

  it('changes when the title changes — the classifier reads it too', () => {
    expect(evidenceFingerprint('Backend Engineer', BODY(500))).not.toBe(
      evidenceFingerprint('HR Manager', BODY(500)),
    );
  });

  it('is NOT changed by reformatting — a reflow is not a fact about the job', () => {
    expect(evidenceFingerprint('Backend  Engineer', '  Build   services.\n\n')).toBe(
      evidenceFingerprint('Backend Engineer', 'Build services.'),
    );
  });

  it('ignores text beyond what the classifier actually reads', () => {
    // The model sees the first 6,000 characters. Invalidating over text it
    // never saw would pay $0.019 to reach the same answer.
    const base = BODY(6000);
    expect(evidenceFingerprint('X', base)).toBe(evidenceFingerprint('X', base + BODY(500)));
  });
});

describe('isClassificationStale', () => {
  const job = (description: string, title = 'Backend Engineer') => ({ title, description });

  it('DISCARDS a classification computed on a stub once a real body arrives', () => {
    // The measured defect, in one assertion.
    const cached = evidenceOf(job(STUB));
    expect(isClassificationStale(cached, job(BODY(4000)))).toBe(true);
  });

  it('keeps a classification whose evidence has not changed', () => {
    const cached = evidenceOf(job(BODY(4000)));
    expect(isClassificationStale(cached, job(BODY(4000)))).toBe(false);
  });

  it('keeps a classification when the body was already sufficient and merely changed', () => {
    // Re-running the classifier on every text edit would have re-billed the
    // whole 5,270-job description repair at roughly $100 for the same answers.
    const cached = evidenceOf(job(BODY(4000)));
    expect(isClassificationStale(cached, job(BODY(4200)))).toBe(false);
  });

  it('keeps a classification when the body is still insufficient', () => {
    // Nothing to gain: the gate will refuse it again for want of evidence.
    const cached = evidenceOf(job(STUB));
    expect(isClassificationStale(cached, job('a bit longer but still short'))).toBe(false);
  });

  it('invalidates exactly at the threshold crossing, not one character short', () => {
    const cached = evidenceOf(job(STUB));
    expect(isClassificationStale(cached, job(BODY(MIN_DESCRIPTION_CHARS)))).toBe(true);
    expect(isClassificationStale(cached, job(BODY(MIN_DESCRIPTION_CHARS - 1)))).toBe(false);
  });

  it('treats rows with no recorded provenance as usable', () => {
    // Written before provenance existed. Nothing here can know what they were
    // computed on, and guessing would either invalidate most of the corpus or
    // silently keep contaminated rows. The known-contaminated ones are a
    // separate, deliberate cleanup with their own evidence.
    expect(
      isClassificationStale({ evidenceFingerprint: null, evidenceLength: null }, job(BODY(4000))),
    ).toBe(false);
    expect(
      isClassificationStale({ evidenceFingerprint: 'abc', evidenceLength: null }, job(BODY(4000))),
    ).toBe(false);
  });
});

describe('evidenceOf records what the classifier read', () => {
  it('captures both the fingerprint and the length', () => {
    const e = evidenceOf({ title: 'Backend Engineer', description: BODY(1234) });
    expect(e.evidenceFingerprint).toHaveLength(32);
    expect(e.evidenceLength).toBe(1234);
  });

  it('round-trips: what it records is not stale against the same job', () => {
    const j = { title: 'Backend Engineer', description: BODY(4000) };
    expect(isClassificationStale(evidenceOf(j), j)).toBe(false);
  });
});

describe('the call site must actually use it', () => {
  /**
   * The logic being right is worthless if the cache path ignores it, and the
   * upsert's `update: {}` meant a reclassification could never persist: the row
   * survived, the fresh answer was thrown away, and the next run read the stale
   * one again.
   */
  const src = readFileSync(join(__dirname, 'matching.service.ts'), 'utf8');

  it('drops stale classifications before deciding what to classify', () => {
    expect(src).toMatch(/isClassificationStale\(row, \{ title: job\.title, description: job\.description \}\)/);
    expect(src).toMatch(/byJob\.delete\(jobId\)/);
  });

  it('records provenance when writing a classification', () => {
    expect(src).toMatch(/\.\.\.evidenceOf\(\{ title: job\?\.title/);
  });

  it('PERSISTS a reclassification — the upsert no longer updates nothing', () => {
    const upsert = src.slice(src.indexOf('jobClassification.upsert('));
    const block = upsert.slice(0, upsert.indexOf('});'));
    expect(block).toMatch(/update: fields,/);
    expect(block).not.toMatch(/update: \{\},/);
  });

  it('says so out loud when it discards one', () => {
    // Silent recovery hides that a job was previously judged on older evidence.
    expect(src).toMatch(/cached classification\(s\) discarded/);
  });
});
