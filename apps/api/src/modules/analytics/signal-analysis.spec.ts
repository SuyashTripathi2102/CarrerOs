import {
  aggregateSignalOutcomes,
  recommendationQuality,
  type OppEventInput,
} from './signal-analysis';

const ev = (type: string, score: number, mods: [string, number][]): OppEventInput => ({
  type,
  opportunityScore: score,
  breakdown: mods.map(([module, s]) => ({ module, score: s, weight: 10 })),
});

describe('aggregateSignalOutcomes', () => {
  it('counts events by type', () => {
    const out = aggregateSignalOutcomes([
      ev('CLICKED', 80, []),
      ev('CLICKED', 70, []),
      ev('DISMISSED', 40, []),
      ev('VIEWED', 60, []),
    ]);
    expect(out.counts).toEqual({ CLICKED: 2, DISMISSED: 1, VIEWED: 1 });
  });

  it('separates engaged (clicked/applied) from dismissed scores', () => {
    const out = aggregateSignalOutcomes([
      ev('APPLIED', 90, []),
      ev('CLICKED', 80, []),
      ev('DISMISSED', 30, []),
    ]);
    expect(out.avgScore.engaged).toBe(85);
    expect(out.avgScore.dismissed).toBe(30);
  });

  it('ranks signals by lift — the module that best separates engagement', () => {
    const out = aggregateSignalOutcomes([
      ev('APPLIED', 85, [
        ['resumeFit', 90],
        ['freshness', 50],
      ]),
      ev('CLICKED', 80, [
        ['resumeFit', 88],
        ['freshness', 55],
      ]),
      ev('DISMISSED', 40, [
        ['resumeFit', 40],
        ['freshness', 52],
      ]),
    ]);
    // resumeFit: engaged ~89 vs dismissed 40 -> big lift; freshness ~52 vs 52 -> ~0
    expect(out.signals[0].module).toBe('resumeFit');
    expect(out.signals[0].lift).toBeGreaterThan(40);
    const fresh = out.signals.find((s) => s.module === 'freshness')!;
    // Both sides are observed in this fixture, so lift is a real measurement
    // rather than null — assert that first, then its magnitude.
    expect(fresh.lift).not.toBeNull();
    expect(Math.abs(fresh.lift as number)).toBeLessThan(5);
  });

  it('treats SHOWN as neutral (not counted in engaged/dismissed sample)', () => {
    const out = aggregateSignalOutcomes([ev('SHOWN', 70, [['resumeFit', 80]])]);
    expect(out.sampleSize).toBe(0);
    expect(out.signals).toHaveLength(0);
  });

  it('handles an empty log without throwing', () => {
    const out = aggregateSignalOutcomes([]);
    expect(out.sampleSize).toBe(0);
    expect(out.avgScore.engaged).toBeNull();
  });
});

describe('recommendationQuality', () => {
  it('computes CTR, apply and dismiss rates from impressions', () => {
    const events: OppEventInput[] = [
      ...Array.from({ length: 100 }, () => ev('SHOWN', 60, [])),
      ...Array.from({ length: 34 }, () => ev('CLICKED', 70, [])),
      ...Array.from({ length: 11 }, () => ev('APPLIED', 88, [])),
      ...Array.from({ length: 18 }, () => ev('DISMISSED', 40, [])),
    ];
    const q = recommendationQuality(events);
    expect(q.shown).toBe(100);
    expect(q.ctr).toBe(34);
    expect(q.applyRate).toBe(11);
    expect(q.dismissRate).toBe(18);
    expect(q.avgScoreApplied).toBe(88);
    expect(q.avgScoreDismissed).toBe(40);
  });

  it('returns null rates with no impressions (no divide-by-zero)', () => {
    const q = recommendationQuality([]);
    expect(q.ctr).toBeNull();
    expect(q.applyRate).toBeNull();
  });
});

/**
 * Regression: the outcome log is a JSON column, so its shape is not enforced by
 * the type system. On 2026-08-21 the first real outcome ever recorded made both
 * /analytics/quality and /analytics/signals return 500 —
 * "object is not iterable" — because a wrapped breakdown reached the module
 * loop. Both surfaces had returned 200 for as long as the tables were empty.
 */
describe('breakdown arrives from a JSON column, not from the type system', () => {
  const raw = (breakdown: unknown): OppEventInput =>
    ({ type: 'CLICKED', opportunityScore: 80, breakdown } as unknown as OppEventInput);

  it('does not throw on the wrapped { modules } envelope the notifier writes', () => {
    expect(() =>
      aggregateSignalOutcomes([raw({ modules: [{ module: 'resumeFit', score: 95, weight: 35 }] })]),
    ).not.toThrow();
  });

  it('does not throw on any other non-array JSON value', () => {
    for (const bad of [{}, 'unavailable', 42, true]) {
      expect(() => aggregateSignalOutcomes([raw(bad)])).not.toThrow();
    }
  });

  it('still counts the event when its breakdown is unusable', () => {
    // The event is evidence even if its modules are not readable: dropping it
    // would understate engagement rather than admit the breakdown is missing.
    const out = aggregateSignalOutcomes([raw({}), raw(null)]);
    expect(out.counts).toEqual({ CLICKED: 2 });
    expect(out.avgScore.engaged).toBe(80);
    expect(out.signals).toEqual([]);
  });
});

describe('lift is a measurement, so it needs both sides', () => {
  it('reports null lift for a module never seen in a dismissal', () => {
    // The first real outcome ever logged produced exactly this: one CLICKED,
    // one APPLIED, zero DISMISSED. Every module then read "lift +100" in green
    // — a maximum-confidence claim resting on no counter-evidence at all.
    const out = aggregateSignalOutcomes([ev('CLICKED', 94, [['freshness', 100]])]);
    expect(out.signals).toEqual([
      {
        module: 'freshness',
        avgWhenEngaged: 100,
        avgWhenDismissed: null,
        lift: null,
        nEngaged: 1,
        nDismissed: 0,
      },
    ]);
  });

  it('reports null lift for a module seen only in dismissals', () => {
    const out = aggregateSignalOutcomes([ev('DISMISSED', 20, [['salary', 10]])]);
    expect(out.signals[0]).toMatchObject({ avgWhenEngaged: null, avgWhenDismissed: 10, lift: null });
  });

  it('computes lift once both sides exist', () => {
    const out = aggregateSignalOutcomes([
      ev('CLICKED', 90, [['resumeFit', 90]]),
      ev('DISMISSED', 30, [['resumeFit', 40]]),
    ]);
    expect(out.signals[0]).toMatchObject({ lift: 50, nEngaged: 1, nDismissed: 1 });
  });

  it('ranks measured signals above unmeasured ones regardless of magnitude', () => {
    const out = aggregateSignalOutcomes([
      ev('CLICKED', 90, [['measured', 60], ['unmeasured', 100]]),
      ev('DISMISSED', 30, [['measured', 50]]),
    ]);
    expect(out.signals.map((s) => s.module)).toEqual(['measured', 'unmeasured']);
  });
});
