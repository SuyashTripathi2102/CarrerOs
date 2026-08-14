import { AnalyticsService } from './analytics.service';

/**
 * Regression suite for the score-divergence incident (2026-08-14).
 *
 * CareerOS has two Opportunity Scores:
 *
 *   surface  `browseByFit` — 7 inputs, resumeFit = raw cosine similarity,
 *            recomputed per request, NEVER persisted. Drives /today + /browse.
 *   stored   the deep 10-module score + APPLY/CONSIDER/SKIP verdict in
 *            job_matches, written by the deep-scoring path.
 *
 * They were measured to disagree severely: a card rendered as
 * "Apply to XO Health — Opportunity 71" carried a stored verdict of SKIP at
 * 16.9, and 7 of the 9 stored-APPLY jobs (78.3–92.1) were absent from the
 * top-100 surface feed entirely.
 *
 * An event that snapshots only the stored decision therefore attributes the
 * user's click to a number they never saw, which would have made five days of
 * conversion data confidently wrong. Both values are recorded, and NEITHER may
 * overwrite or "correct" the other — where they differ, the difference is the
 * evidence the scoring audit needs.
 */
describe('opportunity events: displayed vs stored', () => {
  const XO_HEALTH = {
    jobId: 'bb39c59b-86d1-4303-9abd-d914eba51640',
    displayed: 71, // what /today rendered
    storedScore: 16.9, // what job_matches held
    storedVerdict: 'SKIP',
  };

  function makeService(match: unknown, job: unknown) {
    const created: Record<string, unknown>[] = [];
    const prisma = {
      jobMatch: { findFirst: jest.fn().mockResolvedValue(match) },
      job: { findUnique: jest.fn().mockResolvedValue(job) },
      opportunityEvent: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return Promise.resolve(data);
        }),
        createMany: jest.fn(({ data }: { data: Record<string, unknown>[] }) => {
          created.push(...data);
          return Promise.resolve({ count: data.length });
        }),
      },
      jobMatchFindMany: undefined,
    } as unknown as ConstructorParameters<typeof AnalyticsService>[0];
    return { service: new AnalyticsService(prisma), created };
  }

  it('records the displayed score even when the stored verdict contradicts it', async () => {
    const { service, created } = makeService(
      { opportunityScore: XO_HEALTH.storedScore, verdict: XO_HEALTH.storedVerdict, decisionVersion: 2 },
      { source: 'jooble' },
    );

    await service.record('u1', XO_HEALTH.jobId, 'CLICKED', 'today', 2, {
      displayedScore: XO_HEALTH.displayed,
    });

    expect(created).toHaveLength(1);
    const ev = created[0];
    // Both survive, independently.
    expect(ev.displayedScore).toBe(71);
    expect(ev.opportunityScore).toBe(16.9);
    expect(ev.verdict).toBe('SKIP');
  });

  it('never overwrites the stored decision with the displayed one', async () => {
    const { service, created } = makeService(
      { opportunityScore: 16.9, verdict: 'SKIP', decisionVersion: 2 },
      { source: 'jooble' },
    );

    await service.record('u1', XO_HEALTH.jobId, 'CLICKED', 'today', 2, {
      displayedScore: 71,
      displayedVerdict: 'APPLY',
    });

    const ev = created[0];
    expect(ev.verdict).toBe('SKIP'); // stored is untouched
    expect(ev.displayedVerdict).toBe('APPLY'); // displayed is untouched
    expect(ev.verdict).not.toBe(ev.displayedVerdict); // the divergence is preserved
  });

  it('records a displayed score for a job with NO stored match at all', async () => {
    // /today's top card ("Apply to jobgether — Opportunity 72") had no
    // job_matches row. Without displayedScore this event carries no number.
    const { service, created } = makeService(null, { source: 'lever' });

    await service.record('u1', '0c8c0d56-385f-4740-90b8-513ace43f36c', 'CLICKED', 'today', 1, {
      displayedScore: 72,
    });

    const ev = created[0];
    expect(ev.displayedScore).toBe(72);
    expect(ev.opportunityScore).toBeNull();
    expect(ev.verdict).toBeNull();
  });

  it('leaves displayed fields NULL when the emitter reports none', async () => {
    // Server-side APPLIED events from the tracker have nothing on screen.
    // NULL must mean "not reported", never "displayed as zero".
    const { service, created } = makeService(
      { opportunityScore: 84.1, verdict: 'APPLY', decisionVersion: 2 },
      { source: 'greenhouse' },
    );

    await service.record('u1', 'job-1', 'APPLIED', 'tracker');

    const ev = created[0];
    expect(ev.displayedScore).toBeNull();
    expect(ev.displayedVerdict).toBeNull();
    expect(ev.opportunityScore).toBe(84.1);
  });

  it('carries displayed scores through the batch impression path', async () => {
    const { service, created } = makeService(null, null);
    // recordImpressions uses findMany, not findFirst — stub both shapes.
    const prisma = (service as unknown as { prisma: Record<string, unknown> }).prisma;
    (prisma.jobMatch as Record<string, unknown>).findMany = jest.fn().mockResolvedValue([]);
    (prisma.job as Record<string, unknown>).findMany = jest.fn().mockResolvedValue([]);

    await service.recordImpressions('u1', 'today', [
      { jobId: 'a', rank: 1, displayedScore: 72 },
      { jobId: 'b', rank: 2, displayedScore: 71 },
    ]);

    expect(created.map((e) => e.displayedScore)).toEqual([72, 71]);
    // Stored side is absent for these jobs, and that asymmetry is the point.
    expect(created.every((e) => e.opportunityScore === null)).toBe(true);
  });
});
