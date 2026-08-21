import { aggregateSourceOutcomes, type SourceEventInput, type SourceApplicationInput } from './source-outcomes';

const ev = (type: string, discoveredBy: string | null, acquiredFrom: string | null): SourceEventInput =>
  ({ type, discoveredBy, acquiredFrom });
const app = (status: string, discoveredBy: string | null, acquiredFrom: string | null): SourceApplicationInput =>
  ({ status, discoveredBy, acquiredFrom });

describe('the two axes are genuinely different', () => {
  it('attributes one job to different sources on each axis', () => {
    // The real shape: FreeHire introduced the company, Greenhouse supplied the
    // job. Reading only acquiredFrom credits Greenhouse for a company we would
    // never have found without FreeHire — the error that made the Workday
    // rollout look like diversification.
    const out = aggregateSourceOutcomes(
      [ev('SHOWN', 'freehire', 'greenhouse'), ev('CLICKED', 'freehire', 'greenhouse')],
      [],
      '90d',
    );
    expect(out.byDiscovery.map((r) => r.source)).toEqual(['freehire']);
    expect(out.byAcquisition.map((r) => r.source)).toEqual(['greenhouse']);
    expect(out.byDiscovery[0].shown).toBe(1);
    expect(out.byAcquisition[0].shown).toBe(1);
  });

  it('keeps unattributed rows visible instead of dropping them', () => {
    // Dropping them would silently shrink every denominator and inflate the
    // rates of the sources that DO have attribution.
    const out = aggregateSourceOutcomes([ev('SHOWN', null, null)], [], '90d');
    expect(out.byDiscovery[0].source).toBe('(unattributed)');
    expect(out.byDiscovery[0].shown).toBe(1);
  });
});

describe('rates refuse to answer before they mean anything', () => {
  it('reports null interviewRate below the volume floor', () => {
    // One interview from one application is one data point, not 100%.
    const out = aggregateSourceOutcomes(
      [],
      [app('INTERVIEW', 'freehire', 'lever')],
      '90d',
    );
    expect(out.byDiscovery[0].applied).toBe(1);
    expect(out.byDiscovery[0].interviews).toBe(1);
    expect(out.byDiscovery[0].interviewRate).toBeNull();
  });

  it('reports interviewRate once the floor is reached', () => {
    const apps = [
      ...Array.from({ length: 4 }, () => app('REJECTED', 'freehire', 'lever')),
      app('OFFER', 'freehire', 'lever'),
    ];
    const out = aggregateSourceOutcomes([], apps, '90d');
    expect(out.byDiscovery[0].applied).toBe(5);
    expect(out.byDiscovery[0].interviews).toBe(1);
    expect(out.byDiscovery[0].interviewRate).toBe(20);
  });

  it('counts REJECTED as applied — a rejection proves an application', () => {
    // Excluding it would shrink the denominator and inflate every rate.
    const out = aggregateSourceOutcomes([], [app('REJECTED', 'yc', 'ashby')], '90d');
    expect(out.byDiscovery[0].applied).toBe(1);
    expect(out.byDiscovery[0].interviews).toBe(0);
  });

  it('does not count SAVED as applied — a bookmark is not an application', () => {
    const out = aggregateSourceOutcomes([], [app('SAVED', 'yc', 'ashby')], '90d');
    expect(out.byDiscovery[0].applied).toBe(0);
  });

  it('returns null ctr when nothing was shown, never 0', () => {
    // 0% CTR asserts the user ignored the source. Null says we never showed it.
    const out = aggregateSourceOutcomes([], [app('APPLIED', 'freehire', 'lever')], '90d');
    expect(out.byDiscovery[0].shown).toBe(0);
    expect(out.byDiscovery[0].ctr).toBeNull();
    expect(out.byDiscovery[0].applyRate).toBeNull();
  });
});

describe('ranking', () => {
  it('ranks by interviews, not by rate', () => {
    // A 100%-interview-rate source off 1 application must not outrank a source
    // with 3 real interviews.
    const apps = [
      app('INTERVIEW', 'big', 'x'), app('INTERVIEW', 'big', 'x'), app('INTERVIEW', 'big', 'x'),
      ...Array.from({ length: 20 }, () => app('REJECTED', 'big', 'x')),
      app('INTERVIEW', 'tiny', 'y'),
    ];
    const out = aggregateSourceOutcomes([], apps, '90d');
    expect(out.byDiscovery.map((r) => r.source)).toEqual(['big', 'tiny']);
  });
});
