import { boardHasPostings } from './prober';

/**
 * "This board exists" is not "this company posts here".
 *
 * The prober's validators accept `Array.isArray(payload.jobs)`, which is true
 * for `[]`. Large employers routinely hold an empty shell account on one ATS
 * while hiring on another, so the first shell found won the company. Verified
 * against the live API 2026-08-16:
 *
 *   apply.workable.com/api/v1/widget/accounts/zensar   -> 200 {"jobs":[]}
 *   apply.workable.com/api/v1/widget/accounts/nonsense -> 404
 *
 * Zensar really does hold that Workable account; their postings are on Oracle.
 * 169 companies labelled WORKABLE produced 1,172 zero-find crawls of 1,426,
 * and before the reconciliation guards each one wiped the company's jobs.
 */
describe('boardHasPostings', () => {
  describe('empty boards are NOT evidence of where a company hires', () => {
    it('Workable/Greenhouse/Ashby shape', () => {
      expect(boardHasPostings({ name: 'Zensar', jobs: [] })).toBe(false);
    });
    it('Lever/Breezy shape (bare array)', () => {
      expect(boardHasPostings([])).toBe(false);
    });
    it('Recruitee shape', () => {
      expect(boardHasPostings({ offers: [] })).toBe(false);
    });
    it('SmartRecruiters shape', () => {
      expect(boardHasPostings({ totalFound: 0 })).toBe(false);
    });
  });

  describe('boards with real postings win', () => {
    it('Workable/Greenhouse/Ashby shape', () => {
      expect(boardHasPostings({ jobs: [{ id: 1 }] })).toBe(true);
    });
    it('Lever/Breezy shape', () => {
      expect(boardHasPostings([{ id: 'a' }])).toBe(true);
    });
    it('Recruitee shape', () => {
      expect(boardHasPostings({ offers: [{ id: 1 }] })).toBe(true);
    });
    it('SmartRecruiters shape', () => {
      expect(boardHasPostings({ totalFound: 12 })).toBe(true);
    });
  });

  describe('garbage is never a posting', () => {
    it.each([[null], [undefined], [{}], ['a string'], [42], [{ jobs: 'not an array' }]])(
      '%p',
      (payload) => {
        expect(boardHasPostings(payload)).toBe(false);
      },
    );
  });

  it('the Zensar case: an empty Workable shell must not outrank a live board', () => {
    const workableShell = { name: 'Zensar', description: null, jobs: [] };
    const liveBoard = { jobs: [{ id: 'oracle-1' }, { id: 'oracle-2' }] };
    expect(boardHasPostings(workableShell)).toBe(false);
    expect(boardHasPostings(liveBoard)).toBe(true);
  });
});
