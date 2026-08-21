import { decideReconciliation } from './crawl-reconciliation';

/**
 * P0 regression suite: a crawl must never delete opportunities it is not
 * authoritative for.
 *
 * Measured cost of the missing guards (2026-08-15/16): 606 FreeHire jobs
 * retired, 386 with no replacement anywhere, 18 of 31 actionable opportunities
 * destroyed including 4 APPLY scoring 84.5-87.8 -- higher than anything then on
 * the live board.
 */

/** Mirrors the updateMany predicate in syncCompanyJobs. */
function jobsRetired(
  existing: { externalId: string; source: string; status: 'ACTIVE' | 'REMOVED' }[],
  crawl: { source: string; seenExternalIds: string[]; succeeded: boolean },
): string[] {
  const decision = decideReconciliation({
    seenExternalIds: crawl.seenExternalIds,
    crawlSucceeded: crawl.succeeded,
  });
  if (!decision.retire) return [];
  return existing
    .filter(
      (j) =>
        j.status === 'ACTIVE' &&
        j.source === crawl.source &&
        !crawl.seenExternalIds.includes(j.externalId),
    )
    .map((j) => j.externalId);
}

const board = [
  { externalId: 'wk-1', source: 'workable', status: 'ACTIVE' as const },
  { externalId: 'wk-2', source: 'workable', status: 'ACTIVE' as const },
  { externalId: 'freehire-zensar-fullstack', source: 'freehire', status: 'ACTIVE' as const },
  { externalId: 'freehire-zensar-react', source: 'freehire', status: 'ACTIVE' as const },
];

describe('guard 1: an empty crawl retires nothing', () => {
  it('EMPTY_RESULT — the bug that wiped the board', () => {
    // `notIn: []` matched every row. This is the single line that destroyed
    // 4 APPLY opportunities.
    const d = decideReconciliation({ seenExternalIds: [], crawlSucceeded: true });
    expect(d).toEqual({ retire: false, reason: 'EMPTY_RESULT' });
    expect(jobsRetired(board, { source: 'workable', seenExternalIds: [], succeeded: true })).toEqual([]);
  });

  it('CRAWL_FAILED — adapter error, timeout, rate limit, parser break', () => {
    const d = decideReconciliation({ seenExternalIds: [], crawlSucceeded: false });
    expect(d).toEqual({ retire: false, reason: 'CRAWL_FAILED' });
  });

  it('a FAILED crawl that somehow returned rows still retires nothing', () => {
    // Partial results from a failing adapter are not a complete board.
    expect(
      jobsRetired(board, { source: 'workable', seenExternalIds: ['wk-1'], succeeded: false }),
    ).toEqual([]);
  });

  it('a previously populated board going empty preserves everything', () => {
    // The Zensar shape exactly: real Workable account, zero open jobs.
    expect(jobsRetired(board, { source: 'workable', seenExternalIds: [], succeeded: true })).toEqual([]);
  });
});

describe('guard 2: a crawl only reconciles its OWN source', () => {
  it('a Workable crawl never retires FreeHire jobs', () => {
    // The cross-source deletion. A Workable board says nothing about a job
    // discovered through FreeHire, and their externalId namespaces differ, so
    // the FreeHire rows could never appear in `seenExternalIds`.
    const retired = jobsRetired(board, {
      source: 'workable',
      seenExternalIds: ['wk-1'],
      succeeded: true,
    });
    expect(retired).toEqual(['wk-2']);
    expect(retired).not.toContain('freehire-zensar-fullstack');
    expect(retired).not.toContain('freehire-zensar-react');
  });

  it('a FreeHire re-crawl does not retire Workable jobs either', () => {
    const retired = jobsRetired(board, {
      source: 'freehire',
      seenExternalIds: ['freehire-zensar-fullstack'],
      succeeded: true,
    });
    expect(retired).toEqual(['freehire-zensar-react']);
  });
});

describe('normal reconciliation still works', () => {
  it('a successful non-empty crawl retires its own absent jobs', () => {
    expect(
      jobsRetired(board, { source: 'workable', seenExternalIds: ['wk-1'], succeeded: true }),
    ).toEqual(['wk-2']);
  });

  it('a crawl seeing everything retires nothing', () => {
    expect(
      jobsRetired(board, { source: 'workable', seenExternalIds: ['wk-1', 'wk-2'], succeeded: true }),
    ).toEqual([]);
  });

  it('already-REMOVED jobs are not touched again', () => {
    const withRemoved = [
      ...board,
      { externalId: 'wk-old', source: 'workable', status: 'REMOVED' as const },
    ];
    expect(
      jobsRetired(withRemoved, { source: 'workable', seenExternalIds: ['wk-1'], succeeded: true }),
    ).toEqual(['wk-2']);
  });
});

/**
 * The five companies from the audit. Each had a REAL but EMPTY Workable
 * account discovered by slug-guessing, while their actual postings live on
 * Workday / Oracle Cloud / iCIMS. Verified against the live API:
 *   apply.workable.com/api/v1/widget/accounts/zensar   -> 200 {"jobs":[]}
 *   apply.workable.com/api/v1/widget/accounts/nonsense -> 404
 */
describe('the real failures, reproduced', () => {
  it.each([
    ['Zensar', 'freehire-zensar-fullstack', 87.8],
    ['Zensar Technologies', 'freehire-zensar-react', 87.6],
    ['Ares Management', 'freehire-ares-fullstack', 85.2],
    ['Broadridge', 'freehire-broadridge-java', 0],
    ['Kyndryl', 'freehire-kyndryl-backend', 0],
    ['PepsiCo', 'freehire-pepsico-архитектор'.normalize(), 0],
  ])('%s: an empty Workable board no longer deletes the FreeHire job', (_company, externalId) => {
    const existing = [{ externalId, source: 'freehire', status: 'ACTIVE' as const }];
    // Old behaviour: seenExternalIds [] + no source filter -> this job retired.
    expect(
      jobsRetired(existing, { source: 'workable', seenExternalIds: [], succeeded: true }),
    ).toEqual([]);
  });

  it('even a NON-empty Workable board cannot touch the FreeHire job', () => {
    // Belt and braces: guard 2 holds independently of guard 1.
    const existing = [
      { externalId: 'freehire-zensar-fullstack', source: 'freehire', status: 'ACTIVE' as const },
    ];
    expect(
      jobsRetired(existing, { source: 'workable', seenExternalIds: ['wk-99'], succeeded: true }),
    ).toEqual([]);
  });
});

/**
 * GUARD 3 — the truncated walk (2026-08-21).
 *
 * The first two guards catch a crawl that failed and a crawl that returned
 * nothing. A walk that stopped at its page cap is neither: it SUCCEEDED and it
 * returned plenty. It then retires every job past the last page it read.
 *
 * Found by reading FreeHire's `crawlAllPagedLinks`, which inverts its own
 * page-failure rule wherever the sweep is catalogue-scoped, for this reason.
 */
describe('a partial board is not authority over the whole board', () => {
  it('does not retire when the walk stopped short', () => {
    expect(
      decideReconciliation({
        seenExternalIds: ['wd-1', 'wd-2'],
        crawlSucceeded: true,
        boardComplete: false,
      }),
    ).toEqual({ retire: false, reason: 'PARTIAL_BOARD' });
  });

  it('still retires when the walk reached the end', () => {
    expect(
      decideReconciliation({
        seenExternalIds: ['wd-1'],
        crawlSucceeded: true,
        boardComplete: true,
      }),
    ).toEqual({ retire: true });
  });

  it('treats an omitted flag as complete, so non-paginating adapters are unchanged', () => {
    // Eight adapters never report completeness because they cannot walk off the
    // end of a board. Defaulting to "unknown" would silently stop all retirement
    // and let dead jobs accumulate forever — the opposite failure.
    expect(decideReconciliation({ seenExternalIds: ['gh-1'], crawlSucceeded: true })).toEqual({
      retire: true,
    });
  });

  it('reports the EARLIER failure when a crawl is both partial and empty', () => {
    // Order matters for the log line: "empty" is the more actionable diagnosis,
    // and an empty partial walk is the shape a rate-limited first page takes.
    expect(
      decideReconciliation({ seenExternalIds: [], crawlSucceeded: true, boardComplete: false }),
    ).toEqual({ retire: false, reason: 'EMPTY_RESULT' });
  });

  it('a failed crawl outranks completeness entirely', () => {
    expect(
      decideReconciliation({
        seenExternalIds: ['wd-1'],
        crawlSucceeded: false,
        boardComplete: true,
      }),
    ).toEqual({ retire: false, reason: 'CRAWL_FAILED' });
  });
});
