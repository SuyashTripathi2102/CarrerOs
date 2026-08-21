import { CompaniesService } from './companies.service';

/**
 * Discovery attribution (2026-08-21).
 *
 * `discoveredBy` (which channel introduced the COMPANY) and `acquiredFrom`
 * (which board supplied the JOB) are different facts, and conflating them
 * misreports the thing CareerOS most needs to know:
 *
 *   FreeHire share of actionable, by job source   67.1%
 *   FreeHire share of actionable, by discovery    92.7%
 *
 * The gap is companies FreeHire introduced whose jobs are later acquired from
 * their own ATS. That reads as diversification while the real dependency is
 * unchanged — and it is exactly the conclusion a source-performance dashboard
 * would draw from the wrong column.
 *
 * The writer used to hardcode the literal 'board', destroying the distinction
 * at write time, so a backfill alone would decay back to useless.
 */
describe('findOrCreateFromBoard records WHICH board discovered the company', () => {
  const makeService = () => {
    const created: Array<Record<string, unknown>> = [];
    const repo = {
      findByAts: async () => null,
      findByName: async () => null,
      findByNormalizedName: async () => null,
      update: async () => ({}),
      create: async (data: Record<string, unknown>) => {
        created.push(data);
        return { id: 'c1', ...data };
      },
    };
    const svc = new CompaniesService(repo as never);
    return { svc, created };
  };

  it('persists the board it was told about', async () => {
    const { svc, created } = makeService();
    await svc.findOrCreateFromBoard({ name: 'Acme' }, 'freehire');
    expect(created[0].discoverySource).toBe('freehire');
  });

  it('keeps each board distinct rather than collapsing them', async () => {
    const { svc, created } = makeService();
    await svc.findOrCreateFromBoard({ name: 'A' }, 'freehire');
    await svc.findOrCreateFromBoard({ name: 'B' }, 'jooble');
    await svc.findOrCreateFromBoard({ name: 'C' }, 'remoteok');
    expect(created.map((c) => c.discoverySource)).toEqual(['freehire', 'jooble', 'remoteok']);
  });

  it("falls back to 'board' when the caller genuinely does not know", async () => {
    // Truthful-but-coarse beats inventing a specific channel. It must never
    // write null: the funnel stats then read the company as "manual", which is
    // a claim about a human that nobody made.
    const { svc, created } = makeService();
    await svc.findOrCreateFromBoard({ name: 'Acme' });
    expect(created[0].discoverySource).toBe('board');
  });
});
