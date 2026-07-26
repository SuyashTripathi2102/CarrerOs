import { companyGrowthScore, trendFrom, type GrowthSignals } from './company-growth';

describe('trendFrom', () => {
  it('is INSUFFICIENT_DATA without enough history', () => {
    expect(trendFrom(5, 0, false)).toBe('INSUFFICIENT_DATA');
  });

  it('is INSUFFICIENT_DATA when both windows are empty', () => {
    expect(trendFrom(0, 0, true)).toBe('INSUFFICIENT_DATA');
  });

  it('is GROWING when new roles clearly exceed the prior window', () => {
    expect(trendFrom(10, 4, true)).toBe('GROWING');
    expect(trendFrom(3, 0, true)).toBe('GROWING');
  });

  it('is DECLINING when new roles fall off', () => {
    expect(trendFrom(2, 10, true)).toBe('DECLINING');
  });

  it('is STABLE in between', () => {
    expect(trendFrom(5, 5, true)).toBe('STABLE');
  });
});

describe('companyGrowthScore', () => {
  const base: GrowthSignals = {
    activeJobs: 0,
    newRoles30d: 0,
    trend: 'INSUFFICIENT_DATA',
    daysSinceLastJob: null,
  };

  it('scores a hot, growing, actively-hiring company high', () => {
    const hot: GrowthSignals = {
      activeJobs: 12,
      newRoles30d: 6,
      trend: 'GROWING',
      daysSinceLastJob: 2,
    };
    expect(companyGrowthScore(hot)).toBeGreaterThanOrEqual(90);
  });

  it('scores a dead company low', () => {
    const dead: GrowthSignals = {
      activeJobs: 0,
      newRoles30d: 0,
      trend: 'DECLINING',
      daysSinceLastJob: 200,
    };
    expect(companyGrowthScore(dead)).toBe(0);
  });

  it('rewards recency and penalizes staleness', () => {
    const fresh = companyGrowthScore({ ...base, activeJobs: 3, daysSinceLastJob: 3 });
    const stale = companyGrowthScore({ ...base, activeJobs: 3, daysSinceLastJob: 120 });
    expect(fresh).toBeGreaterThan(stale);
  });

  it('never leaves the [0,100] band', () => {
    const huge: GrowthSignals = {
      activeJobs: 999,
      newRoles30d: 999,
      trend: 'GROWING',
      daysSinceLastJob: 0,
    };
    expect(companyGrowthScore(huge)).toBeLessThanOrEqual(100);
  });
});
