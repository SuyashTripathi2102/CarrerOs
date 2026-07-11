import {
  funnelInsights,
  likelyCauses,
  waitingActions,
  type AppSignals,
} from './application-intelligence';

const base: AppSignals = {
  status: 'REJECTED',
  daysSinceApplied: 10,
  jobAgeAtApplyDays: 2,
  userYears: 2,
  minimumYears: 2,
  missingRequired: [],
  specializationFit: 80,
  hadReferralContact: true,
  tailoredResume: true,
};
const sig = (over: Partial<AppSignals>): AppSignals => ({ ...base, ...over });

describe('likelyCauses', () => {
  it('flags an experience stretch, ranked by the size of the gap', () => {
    const c = likelyCauses(sig({ userYears: 1, minimumYears: 4 }));
    expect(c[0].factor).toBe('Experience stretch');
    expect(c[0].strength).toBe(4);
  });

  it('flags missing required skills and a cold (no-referral) application', () => {
    const c = likelyCauses(sig({ missingRequired: ['TypeScript', 'Docker', 'Redis'], hadReferralContact: false }));
    const factors = c.map((x) => x.factor);
    expect(factors).toContain('Missing required skills');
    expect(factors).toContain('No referral');
  });

  it('flags a late application', () => {
    const c = likelyCauses(sig({ jobAgeAtApplyDays: 26 }));
    expect(c.some((x) => x.factor === 'Applied late')).toBe(true);
  });

  it('says nothing when every signal is healthy', () => {
    expect(likelyCauses(base)).toEqual([]);
  });

  it('never emits more than four causes', () => {
    const c = likelyCauses(
      sig({ userYears: 0, minimumYears: 5, missingRequired: ['a', 'b', 'c'], hadReferralContact: false, jobAgeAtApplyDays: 40, specializationFit: 30 }),
    );
    expect(c.length).toBeLessThanOrEqual(4);
  });
});

describe('waitingActions', () => {
  it('leads with "find a referral" when none exists', () => {
    const a = waitingActions(sig({ hadReferralContact: false }), 'job1');
    expect(a[0].label).toBe('Find a referral');
    expect(a[0].href).toBe('/referrals/job1');
  });

  it('suggests a follow-up once it has been a few days', () => {
    const a = waitingActions(sig({ daysSinceApplied: 6, hadReferralContact: true }), 'job1');
    expect(a.some((x) => x.label === 'Send a follow-up')).toBe(true);
  });

  it('always offers a fallback (apply to similar)', () => {
    const a = waitingActions(sig({ hadReferralContact: true, tailoredResume: true, daysSinceApplied: 1 }), 'job1');
    expect(a[a.length - 1].label).toBe('Apply to similar roles');
  });
});

describe('funnelInsights', () => {
  it('stays silent below a meaningful volume', () => {
    expect(funnelInsights({ applied: 3, withReferral: 0, tailored: 0, interviews: 0 })).toEqual([]);
  });

  it('calls out low referral coverage', () => {
    const i = funnelInsights({ applied: 10, withReferral: 1, tailored: 8, interviews: 1 });
    expect(i.join(' ')).toMatch(/referral/i);
  });

  it('flags zero interviews at volume as a reach problem', () => {
    const i = funnelInsights({ applied: 10, withReferral: 8, tailored: 8, interviews: 0 });
    expect(i.join(' ')).toMatch(/no interviews/i);
  });
});
