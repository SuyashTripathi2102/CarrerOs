import {
  decideReconciliation,
  firstPerExternalId,
  isSuddenDrop,
  type ReconciliationDecision,
  type ReconciliationInput,
} from './crawl-reconciliation';

/**
 * The retirement drop guard (R-1), decision level. Test ids R1-Txx match the
 * guard's regression list; the database-level cases are in
 * retirement-guard.int.spec.ts.
 */

const ids = (n: number, prefix = 'job') =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
const ref = (found: number) => ({ reference: { found } });

/** decideReconciliation exactly as it was before the drop guard, for R1-T15. */
function decideBeforeGuard(input: {
  seenExternalIds: readonly string[];
  crawlSucceeded: boolean;
  boardComplete?: boolean;
}): ReconciliationDecision {
  if (!input.crawlSucceeded) return { retire: false, reason: 'CRAWL_FAILED' };
  if (input.seenExternalIds.length === 0)
    return { retire: false, reason: 'EMPTY_RESULT' };
  if (input.boardComplete === false)
    return { retire: false, reason: 'PARTIAL_BOARD' };
  return { retire: true };
}

describe('the identity rule: firstPerExternalId', () => {
  it('keeps one job per exact externalId, the first occurrence, in order', () => {
    const jobs = [
      { externalId: 'a', title: 'first a' },
      { externalId: 'b', title: 'b' },
      { externalId: 'a', title: 'second a' },
      { externalId: 'c', title: 'c' },
    ];
    expect(firstPerExternalId(jobs)).toEqual([
      { externalId: 'a', title: 'first a' },
      { externalId: 'b', title: 'b' },
      { externalId: 'c', title: 'c' },
    ]);
  });

  it('is exact-string equality, like the (companyId, externalId) unique key', () => {
    const jobs = ['ABC', 'abc', ' abc', 'abc '].map((externalId) => ({
      externalId,
    }));
    expect(firstPerExternalId(jobs)).toHaveLength(4);
  });

  it('returns nothing for nothing, and does not modify its input', () => {
    expect(firstPerExternalId([])).toEqual([]);
    const jobs = [{ externalId: 'x' }, { externalId: 'x' }];
    firstPerExternalId(jobs);
    expect(jobs).toHaveLength(2);
  });
});

describe('Rule B: isSuddenDrop', () => {
  it('R1-T04: exactly half still retires; one fewer is a drop', () => {
    expect(isSuddenDrop(50, 100)).toBe(false);
    expect(isSuddenDrop(49, 100)).toBe(true);
  });

  it('needs no rounding for an odd reference', () => {
    expect(isSuddenDrop(50, 101)).toBe(true); // 50 < 50.5
    expect(isSuddenDrop(51, 101)).toBe(false);
  });

  it('growth and equal counts are never drops', () => {
    expect(isSuddenDrop(100, 100)).toBe(false);
    expect(isSuddenDrop(3000, 100)).toBe(false);
    expect(isSuddenDrop(1, 1)).toBe(false);
  });

  it('at small counts, 1 of 3 is a drop and 1 of 2 is not', () => {
    expect(isSuddenDrop(1, 3)).toBe(true);
    expect(isSuddenDrop(1, 2)).toBe(false);
  });
});

describe('decideReconciliation with the drop guard on', () => {
  const crawl = (
    seen: number,
    extra: Partial<ReconciliationInput> = {},
  ): ReconciliationInput => ({
    seenExternalIds: ids(seen),
    crawlSucceeded: true,
    boardComplete: true,
    ...extra,
  });

  it('R1-T01: a sudden drop (2,452 to 1) is deferred as SUDDEN_DROP', () => {
    expect(decideReconciliation(crawl(1, { dropGuard: ref(2452) }))).toEqual({
      retire: false,
      reason: 'SUDDEN_DROP',
    });
  });

  it('R1-T02: the confirming crawl compares with the deferred one, and retires', () => {
    // The deferred crawl was SUCCEEDED, complete and non-empty, so it is the
    // next crawl's reference: 1 against 1.
    expect(decideReconciliation(crawl(1, { dropGuard: ref(1) }))).toEqual({
      retire: true,
    });
  });

  it('R1-T03: a rebound (2,450 after the deferred 1) retires normally', () => {
    expect(decideReconciliation(crawl(2450, { dropGuard: ref(1) }))).toEqual({
      retire: true,
    });
  });

  it('R1-T04: at reference 100, 50 retires and 49 is deferred', () => {
    expect(decideReconciliation(crawl(50, { dropGuard: ref(100) }))).toEqual({
      retire: true,
    });
    expect(decideReconciliation(crawl(49, { dropGuard: ref(100) }))).toEqual({
      retire: false,
      reason: 'SUDDEN_DROP',
    });
  });

  it('R1-T05: with no previous valid crawl, retirement waits once (NO_REFERENCE)', () => {
    expect(
      decideReconciliation(crawl(1, { dropGuard: { reference: null } })),
    ).toEqual({
      retire: false,
      reason: 'NO_REFERENCE',
    });
  });

  it('R1-T06: a partial walk is PARTIAL_BOARD, before the guard looks at counts', () => {
    expect(
      decideReconciliation(
        crawl(10, { boardComplete: false, dropGuard: ref(1000) }),
      ),
    ).toEqual({ retire: false, reason: 'PARTIAL_BOARD' });
    expect(
      decideReconciliation(
        crawl(10, { boardComplete: false, dropGuard: { reference: null } }),
      ),
    ).toEqual({ retire: false, reason: 'PARTIAL_BOARD' });
  });

  it('R1-T07: a failed crawl is CRAWL_FAILED, whatever the guard sees', () => {
    expect(
      decideReconciliation(
        crawl(500, { crawlSucceeded: false, dropGuard: ref(100) }),
      ),
    ).toEqual({ retire: false, reason: 'CRAWL_FAILED' });
  });

  it('R1-T08: an empty result is EMPTY_RESULT, whatever the guard sees', () => {
    expect(decideReconciliation(crawl(0, { dropGuard: ref(100) }))).toEqual({
      retire: false,
      reason: 'EMPTY_RESULT',
    });
    expect(
      decideReconciliation(crawl(0, { dropGuard: { reference: null } })),
    ).toEqual({
      retire: false,
      reason: 'EMPTY_RESULT',
    });
  });

  it('R1-T10: a 40% shrink at every step is never deferred (the documented limit)', () => {
    let previous = 100;
    for (const seen of [60, 36, 21, 12]) {
      expect(
        decideReconciliation(crawl(seen, { dropGuard: ref(previous) })),
      ).toEqual({
        retire: true,
      });
      previous = seen;
    }
  });

  it('R1-T16: a reference that listed every posting twice still counts 100, so 90 retires', () => {
    const referenceEntries = [...ids(100), ...ids(100)];
    const referenceFound = firstPerExternalId(
      referenceEntries.map((externalId) => ({ externalId })),
    ).length;
    expect(referenceFound).toBe(100);

    const seen = firstPerExternalId(
      ids(90).map((externalId) => ({ externalId })),
    ).map((j) => j.externalId);
    expect(
      decideReconciliation({
        seenExternalIds: seen,
        crawlSucceeded: true,
        dropGuard: ref(referenceFound),
      }),
    ).toEqual({ retire: true });
  });

  it('R1-T17: 40 postings listed three times are 40, not 120: SUDDEN_DROP against 100', () => {
    const entries = [...ids(40), ...ids(40), ...ids(40)].map((externalId) => ({
      externalId,
    }));
    const seen = firstPerExternalId(entries).map((j) => j.externalId);
    expect(seen).toHaveLength(40);
    expect(
      decideReconciliation({
        seenExternalIds: seen,
        crawlSucceeded: true,
        dropGuard: ref(100),
      }),
    ).toEqual({ retire: false, reason: 'SUDDEN_DROP' });
  });
});

describe('R1-T15: with the switch off, decisions are exactly the ones from before the guard', () => {
  const seenSizes = [0, 1, 2, 49, 50, 51, 100, 2452];
  const succeeded = [true, false];
  const complete: (boolean | undefined)[] = [undefined, true, false];
  const matrix = seenSizes.flatMap((n) =>
    succeeded.flatMap((crawlSucceeded) =>
      complete.map((boardComplete) => ({
        seenExternalIds: ids(n),
        crawlSucceeded,
        boardComplete,
      })),
    ),
  );

  it(`matches the pre-guard function on all ${seenSizes.length * 2 * 3} input shapes`, () => {
    for (const input of matrix) {
      expect(decideReconciliation(input)).toEqual(decideBeforeGuard(input));
    }
  });

  it('the guard only ever defers: whenever it retires, the pre-guard function retired too', () => {
    const references = [null, 1, 2, 3, 99, 100, 101, 5000];
    for (const input of matrix) {
      for (const found of references) {
        const guarded = decideReconciliation({
          ...input,
          dropGuard: { reference: found === null ? null : { found } },
        });
        const before = decideBeforeGuard(input);
        if (guarded.retire) expect(before.retire).toBe(true);
        if (!before.retire) expect(guarded).toEqual(before);
        if (before.retire && !guarded.retire) {
          expect(['NO_REFERENCE', 'SUDDEN_DROP']).toContain(guarded.reason);
        }
      }
    }
  });
});
