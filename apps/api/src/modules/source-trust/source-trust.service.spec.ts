import { baselineFor, computeTrustScore, type SourceStats } from './source-trust.service';

describe('baselineFor', () => {
  it('uses curated priors for known sources', () => {
    expect(baselineFor('ashby')).toBe(100);
    expect(baselineFor('adzuna')).toBe(92);
    expect(baselineFor('jooble')).toBe(90);
  });

  it('gives career-page and replay sources the extractor prior', () => {
    expect(baselineFor('career-page-deterministic-v1')).toBe(94);
    expect(baselineFor('career-replay-deterministic-v1')).toBe(94);
  });

  it('falls back to a neutral default for unknown sources', () => {
    expect(baselineFor('some-new-board')).toBe(85);
  });
});

describe('computeTrustScore', () => {
  const clean: SourceStats = { seen: 100, active: 80, removed: 20, stale: 0, fresh: 40 };

  it('returns the baseline when nothing is live', () => {
    expect(computeTrustScore(92, { seen: 5, active: 0, removed: 5, stale: 0, fresh: 0 })).toBe(92);
  });

  it('rewards a source whose live jobs are mostly fresh', () => {
    // 40/80 fresh -> +2 (0.5 * 5 = 2.5 -> 2 or 3), no stale penalty
    expect(computeTrustScore(90, clean)).toBeGreaterThanOrEqual(92);
  });

  it('penalizes a source that lets its listings go stale', () => {
    const stale: SourceStats = { seen: 100, active: 80, removed: 0, stale: 80, fresh: 0 };
    // full stale rate -> -12
    expect(computeTrustScore(94, stale)).toBe(82);
  });

  it('never leaves the [40, 100] band', () => {
    const awful: SourceStats = { seen: 100, active: 100, removed: 0, stale: 100, fresh: 0 };
    expect(computeTrustScore(45, awful)).toBeGreaterThanOrEqual(40);
    const perfect: SourceStats = { seen: 100, active: 100, removed: 0, stale: 0, fresh: 100 };
    expect(computeTrustScore(100, perfect)).toBe(100);
  });
});
