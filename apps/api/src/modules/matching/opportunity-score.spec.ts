import { competitionFromAge, opportunityScore, type OppSignals } from './opportunity-score';

const sig = (over: Partial<OppSignals>): OppSignals => ({
  resumeFit: 80,
  ageDays: 5,
  referral: 'NONE',
  watched: false,
  hiringTrend: null,
  applied: false,
  ...over,
});

describe('opportunityScore', () => {
  it('rewards a fresh, watched, referral-in-flight job over a stale cold one', () => {
    const hot = opportunityScore(sig({ resumeFit: 84, ageDays: 0, referral: 'CONTACTED', watched: true }));
    const cold = opportunityScore(sig({ resumeFit: 92, ageDays: 50, referral: 'NONE', watched: false }));
    expect(hot.score).toBeGreaterThan(cold.score); // fit isn't everything
  });

  it('surfaces the referral as a top factor', () => {
    const o = opportunityScore(sig({ referral: 'CONTACTED' }));
    expect(o.factors.some((f) => /referral in flight/i.test(f.label) && f.delta === 12)).toBe(true);
  });

  it('sinks already-applied jobs', () => {
    const applied = opportunityScore(sig({ applied: true }));
    const not = opportunityScore(sig({ applied: false }));
    expect(applied.score).toBeLessThan(not.score);
    expect(applied.factors.some((f) => f.delta === -18)).toBe(true);
  });

  it('maps freshness to a competition estimate', () => {
    expect(competitionFromAge(1)).toBe('LOW');
    expect(competitionFromAge(8)).toBe('MEDIUM');
    expect(competitionFromAge(40)).toBe('HIGH');
    expect(competitionFromAge(null)).toBe('MEDIUM');
  });

  it('stays within 0–100 and orders factors by magnitude', () => {
    const o = opportunityScore(sig({ resumeFit: 95, ageDays: 0, referral: 'CONTACTED', watched: true, hiringTrend: 'GROWING' }));
    expect(o.score).toBeLessThanOrEqual(100);
    expect(o.score).toBeGreaterThanOrEqual(0);
    expect(Math.abs(o.factors[0].delta)).toBeGreaterThanOrEqual(Math.abs(o.factors[o.factors.length - 1].delta));
  });
});
