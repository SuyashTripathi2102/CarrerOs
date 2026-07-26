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
    expect(Math.abs(fresh.lift)).toBeLessThan(5);
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
