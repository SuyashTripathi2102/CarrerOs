/**
 * Probe validators: which providers may confirm on an EMPTY board?
 *
 * Only those whose endpoint 404s for non-customers. Measured against the live
 * APIs 2026-08-17:
 *
 *   slug           greenhouse  lever  ashby  recruitee  workable  smartrec
 *   zensar            404       404    404      404     200 n=0   200 n=0
 *   kyndryl           404       404    404      404     200 n=0   200 n=0
 *   pepsico           404       404    404      404     200 n=0   200 n=0
 *   barclays          404       404    404      404     200 n=0   200 n=0
 *   qwzxnonsense8842  404       404    404      404       404     200 n=0
 *
 * Workable and SmartRecruiters answer 200 for arbitrary slugs, so an empty
 * board from them proves nothing. Everyone else's 200 means "real customer",
 * and an empty board legitimately means "nothing open today".
 *
 * This is the same lesson as the empty-crawl deletion bug, one layer upstream:
 * an absence is not a measurement. See crawl-reconciliation.ts.
 */

/** Mirrors the validators in guessAtsToken(). */
const validators: Record<string, (p: unknown) => boolean> = {
  GREENHOUSE: (p) => Array.isArray((p as { jobs?: unknown[] })?.jobs),
  LEVER: (p) => Array.isArray(p),
  ASHBY: (p) => Array.isArray((p as { jobs?: unknown[] })?.jobs),
  WORKABLE: (p) => {
    const jobs = (p as { jobs?: unknown })?.jobs;
    return Array.isArray(jobs) && jobs.length > 0;
  },
  SMARTRECRUITERS: (p) => ((p as { totalFound?: number })?.totalFound ?? 0) >= 1,
  RECRUITEE: (p) => Array.isArray((p as { offers?: unknown[] })?.offers),
  BREEZY: (p) => Array.isArray(p),
};

describe('permissive endpoints must NOT confirm on an empty board', () => {
  it('WORKABLE rejects an empty board — the 22-of-22 failure', () => {
    // apply.workable.com 200s with {jobs:[]} for zensar, kyndryl, pepsico,
    // barclays — none of which post there.
    expect(validators.WORKABLE({ name: 'Zensar', description: null, jobs: [] })).toBe(false);
  });

  it('SMARTRECRUITERS rejects an empty board (already did — zero empty crawls)', () => {
    expect(validators.SMARTRECRUITERS({ totalFound: 0 })).toBe(false);
  });

  it('both still accept a board with real postings', () => {
    expect(validators.WORKABLE({ jobs: [{ id: 1 }] })).toBe(true);
    expect(validators.SMARTRECRUITERS({ totalFound: 7 })).toBe(true);
  });
});

describe('specific endpoints MAY confirm on an empty board', () => {
  // These 404 for non-customers, so a 200 already proves customership. An
  // empty board means "real customer, nothing open today" — losing them would
  // silently drop legitimate employers between hiring rounds.
  it.each([
    ['GREENHOUSE', { jobs: [] }],
    ['ASHBY', { jobs: [] }],
    ['RECRUITEE', { offers: [] }],
  ])('%s accepts an empty board', (provider, payload) => {
    expect(validators[provider](payload)).toBe(true);
  });

  it.each([['LEVER'], ['BREEZY']])('%s accepts an empty array board', (provider) => {
    expect(validators[provider]([])).toBe(true);
  });
});

describe('garbage is never a board, for anyone', () => {
  it.each(Object.keys(validators))('%s rejects malformed payloads', (provider) => {
    for (const junk of [null, undefined, {}, 'a string', 42, { jobs: 'nope' }]) {
      expect(validators[provider](junk)).toBe(false);
    }
  });
});

describe('the real companies that were mislabelled', () => {
  // All four hold a real but empty Workable account while posting on
  // Workday / Oracle / iCIMS.
  it.each([['Zensar'], ['Kyndryl'], ['PepsiCo'], ['Barclays']])(
    '%s no longer confirms as WORKABLE on an empty shell',
    (name) => {
      expect(validators.WORKABLE({ name, description: null, jobs: [] })).toBe(false);
    },
  );

  it('a genuine Workable customer with openings still resolves', () => {
    expect(validators.WORKABLE({ name: 'Some Startup', jobs: [{ id: 'a' }, { id: 'b' }] })).toBe(true);
  });
});
