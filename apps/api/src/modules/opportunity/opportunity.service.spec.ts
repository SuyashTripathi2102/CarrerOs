import { HiringTrend } from '@prisma/client';
import { OpportunityService } from './opportunity.service';

/** compute() is pure — no Prisma or SourceTrust needed for these tests. */
const service = new OpportunityService(null as never, null as never);

function ctx(overrides: Partial<Parameters<OpportunityService['compute']>[0]> = {}) {
  return {
    match: {
      overallScore: 85,
      technicalScore: 80,
      experienceScore: 90,
      missingSkills: ['docker'],
      ...(overrides.match ?? {}),
    },
    job: {
      title: 'Backend Engineer',
      location: 'Bengaluru, India',
      postedAt: new Date(Date.now() - 2 * 3_600_000), // 2h ago
      firstSeenAt: new Date(),
      workMode: 'REMOTE',
      salaryMin: 2_000_000,
      salaryMax: 3_000_000,
      currency: 'INR',
      companyId: 'c1',
      source: 'greenhouse',
      sourceTrust: null,
      ...(overrides.job ?? {}),
    },
    prefs: overrides.prefs !== undefined ? overrides.prefs : {
      workModes: ['REMOTE'],
      minSalary: 1_200_000,
      salaryCurrency: 'INR',
      cities: ['Bengaluru', 'Indore'],
    },
    company: {
      name: 'Acme',
      confidence: 90,
      // Default fixture is a fully-measured company: probed, and watched long
      // enough that the 14-day activity signal is real evidence.
      probedAt: new Date(Date.now() - 3 * 86_400_000),
      knownSince: new Date(Date.now() - 60 * 86_400_000),
      hiringTrend: HiringTrend.GROWING,
      recentJobs14d: 6,
      growthScore: null,
      ...(overrides.company ?? {}),
    },
  };
}

/** Weighted blend of a breakdown, mirroring compute()'s renormalization. */
const blend = (mods: { score: number; weight: number }[]) => {
  const w = mods.reduce((s, m) => s + m.weight, 0);
  return w === 0 ? 0 : mods.reduce((s, m) => s + m.score * m.weight, 0) / w;
};
const moduleNames = (r: { breakdown: { module: string }[] }) => r.breakdown.map((m) => m.module);

describe('OpportunityService.compute', () => {
  it('scores a strong fresh match highly with all modules applicable', () => {
    const r = service.compute(ctx());
    expect(r.opportunityScore).toBeGreaterThan(80);
    expect(r.breakdown.map((m) => m.module)).toEqual(
      expect.arrayContaining([
        'resumeFit',
        'experienceFit',
        'freshness',
        'remotePreference',
        'salaryPreference',
        'companyQuality',
        'hiringVelocity',
        'skillGap',
      ]),
    );
  });

  it('renormalizes weights when salary/remote/velocity data is missing', () => {
    const r = service.compute(
      ctx({
        job: { salaryMin: null, salaryMax: null, currency: null, workMode: null } as never,
        company: {
          name: 'Acme',
          confidence: 90,
          hiringTrend: HiringTrend.INSUFFICIENT_DATA,
          recentJobs14d: 0,
        },
      }),
    );
    const modules = r.breakdown.map((m) => m.module);
    expect(modules).not.toContain('salaryPreference');
    expect(modules).not.toContain('remotePreference');
    // Missing data must not act as a penalty: score stays high, not dragged to ~60.
    expect(r.opportunityScore).toBeGreaterThan(75);
  });

  it('falls back to the live 14-day signal when the hiring trend is unknown', () => {
    const quiet = service.compute(
      ctx({
        company: {
          name: 'Acme',
          confidence: 90,
          hiringTrend: HiringTrend.INSUFFICIENT_DATA,
          recentJobs14d: 0,
        },
      }),
    );
    const active = service.compute(
      ctx({
        company: {
          name: 'Acme',
          confidence: 90,
          hiringTrend: HiringTrend.INSUFFICIENT_DATA,
          recentJobs14d: 12,
        },
      }),
    );
    const velocity = (r: ReturnType<OpportunityService['compute']>) =>
      r.breakdown.find((m) => m.module === 'hiringVelocity')!;

    // Never drops out — an unknown trend is not the same as no information.
    expect(velocity(quiet).reason).toBe('no new openings in 14d');
    expect(velocity(active).reason).toContain('actively hiring');
    expect(velocity(active).score).toBeGreaterThan(velocity(quiet).score);
  });

  it('applies the verification gate below confidence 40 (dampen + flag)', () => {
    const trusted = service.compute(ctx());
    const unverified = service.compute(
      ctx({ company: { name: 'Acme', confidence: 0, hiringTrend: null, recentJobs14d: 0 } }),
    );
    expect(unverified.opportunityScore).toBeLessThan(trusted.opportunityScore * 0.9);
    expect(unverified.breakdown.some((m) => m.module === 'verification')).toBe(true);
  });

  it('uses the Phase-5 growth score for hiring velocity when present', () => {
    const strong = service.compute(ctx({ company: { growthScore: 95 } as never }));
    const weak = service.compute(ctx({ company: { growthScore: 10 } as never }));
    const vStrong = strong.breakdown.find((m) => m.module === 'hiringVelocity')!;
    const vWeak = weak.breakdown.find((m) => m.module === 'hiringVelocity')!;
    expect(vStrong.score).toBe(95);
    expect(vStrong.reason).toContain('strong hiring momentum');
    expect(vWeak.score).toBe(10);
    expect(strong.opportunityScore).toBeGreaterThan(weak.opportunityScore);
  });

  it('nudges the score by source trust, bounded and explainable', () => {
    const neutral = service.compute(ctx()); // sourceTrust null -> no module, no nudge
    expect(neutral.breakdown.some((m) => m.module === 'sourceReliability')).toBe(false);

    const trusted = service.compute(ctx({ job: { sourceTrust: 100 } as never }));
    const noisy = service.compute(ctx({ job: { sourceTrust: 60 } as never }));
    expect(trusted.breakdown.some((m) => m.module === 'sourceReliability')).toBe(true);
    // 100 -> +2, 60 -> -4 : the bounded band, trusted clearly above noisy.
    expect(trusted.opportunityScore).toBeGreaterThan(noisy.opportunityScore);
    expect(trusted.opportunityScore - neutral.opportunityScore).toBeLessThanOrEqual(3);
  });

  it('decays freshness for stale postings', () => {
    const fresh = service.compute(ctx());
    const stale = service.compute(
      ctx({ job: { postedAt: new Date(Date.now() - 40 * 86_400_000) } as never }),
    );
    expect(stale.opportunityScore).toBeLessThan(fresh.opportunityScore);
    const staleModule = stale.breakdown.find((m) => m.module === 'freshness');
    expect(staleModule!.score).toBeLessThanOrEqual(40);
  });

  it('penalizes salary below the user floor but never when undisclosed', () => {
    const below = service.compute(
      ctx({ job: { salaryMax: 800_000 } as never }),
    );
    const salaryModule = below.breakdown.find((m) => m.module === 'salaryPreference');
    expect(salaryModule!.score).toBeLessThan(50);

    const undisclosed = service.compute(
      ctx({ job: { salaryMin: null, salaryMax: null } as never }),
    );
    expect(undisclosed.breakdown.find((m) => m.module === 'salaryPreference')).toBeUndefined();
  });

  it('content hash changes when salary changes (re-notify trigger)', () => {
    const a = service.compute(ctx());
    const b = service.compute(ctx({ job: { salaryMax: 3_500_000 } as never }));
    expect(a.contentHash).not.toEqual(b.contentHash);
  });

  // cityPreference is boost-only: a job outside the preferred cities must not be
  // penalised, because most listings carry a vague or missing location.
  it('boosts a job in a preferred city and stays silent outside it', () => {
    const preferred = service.compute(ctx());
    const elsewhere = service.compute(ctx({ job: { location: 'Chennai, India' } as never }));

    const boost = preferred.breakdown.find((m) => m.module === 'cityPreference');
    expect(boost?.score).toBe(100);
    expect(boost?.reason).toContain('Bengaluru');

    expect(elsewhere.breakdown.find((m) => m.module === 'cityPreference')).toBeUndefined();
    expect(preferred.opportunityScore).toBeGreaterThanOrEqual(elsewhere.opportunityScore);
  });

  it('drops cityPreference when the user states no city preference', () => {
    const r = service.compute(
      ctx({ prefs: { workModes: ['REMOTE'], minSalary: null, salaryCurrency: null, cities: [] } }),
    );
    expect(r.breakdown.find((m) => m.module === 'cityPreference')).toBeUndefined();
  });
});

/**
 * UNKNOWN ≠ LOW (2026-08-13).
 *
 * `computeConfidence` starts at 0 and ADDS per positive signal, so a company
 * the prober never visited was indistinguishable from one that failed every
 * check — and `hiringVelocity` reported "no new openings in 14d" about
 * companies discovered three hours earlier. Both invented negative evidence.
 *
 * Measured impact before the fix: 15 of 31 scored matches affected, average
 * +3.63 (max +6.3) once unknown modules dropped, and 7 of 15 flipped
 * SKIP → CONSIDER. 13 of the 15 were board-sourced (Jooble) — precisely the
 * shape every new aggregator source arrives in.
 *
 * The invariant these tests pin:
 *   KNOWN BAD  → negative signal (module scores low)
 *   KNOWN GOOD → positive signal
 *   UNKNOWN    → NO signal (module drops out, weights renormalize)
 */
describe('UNKNOWN ≠ LOW', () => {
  const NEVER = { probedAt: null };
  const brandNew = { knownSince: new Date(Date.now() - 3 * 3_600_000) }; // 3h ago
  const longWatched = { knownSince: new Date(Date.now() - 90 * 86_400_000) };

  describe('companyQuality', () => {
    it('1. never-observed company → module DROPS OUT (not scored 0)', () => {
      const r = service.compute(
        ctx({ company: { confidence: 0, ...NEVER, ...longWatched } as never }),
      );
      expect(moduleNames(r)).not.toContain('companyQuality');
    });

    it('3. verified LOW-confidence company → module STAYS and drags', () => {
      // Evidence of absence: we probed it and it scored badly. That must count.
      const r = service.compute(
        ctx({
          company: {
            confidence: 20,
            probedAt: new Date(Date.now() - 86_400_000),
            ...longWatched,
          } as never,
        }),
      );
      const m = r.breakdown.find((x) => x.module === 'companyQuality');
      expect(m).toBeDefined();
      expect(m?.score).toBe(20);
      expect(m?.reason).toContain('20/100');
    });

    it('5. known healthy company → module stays with its high score', () => {
      const r = service.compute(ctx());
      const m = r.breakdown.find((x) => x.module === 'companyQuality');
      expect(m?.score).toBe(90);
    });

    it('never-observed scores strictly higher than probed-and-failed', () => {
      const unknown = service.compute(
        ctx({ company: { confidence: 0, ...NEVER, ...longWatched } as never }),
      );
      const knownBad = service.compute(
        ctx({ company: { confidence: 0, probedAt: new Date(), ...longWatched } as never }),
      );
      expect(unknown.opportunityScore).toBeGreaterThan(knownBad.opportunityScore);
    });

    it('big tech still scores even when never probed (the name is evidence)', () => {
      const r = service.compute(
        ctx({ company: { name: 'Google', confidence: 0, ...NEVER, ...longWatched } as never }),
      );
      const m = r.breakdown.find((x) => x.module === 'companyQuality');
      expect(m?.score).toBeGreaterThanOrEqual(85);
    });
  });

  describe('hiringVelocity', () => {
    const liveOnly = { growthScore: null, hiringTrend: null };

    it('2. insufficient observation window → module DROPS OUT', () => {
      // Discovered 3h ago with a single old posting: 0 recent jobs is an
      // artifact of not having watched, not a quiet company.
      const r = service.compute(
        ctx({
          company: { ...liveOnly, recentJobs14d: 0, probedAt: new Date(), ...brandNew } as never,
        }),
      );
      expect(moduleNames(r)).not.toContain('hiringVelocity');
    });

    it('4. verified INACTIVE company (window observed) → module STAYS and drags', () => {
      // 90 days watched, zero postings: a genuine quiet period.
      const r = service.compute(
        ctx({
          company: {
            ...liveOnly,
            recentJobs14d: 0,
            probedAt: new Date(),
            ...longWatched,
          } as never,
        }),
      );
      const m = r.breakdown.find((x) => x.module === 'hiringVelocity');
      expect(m).toBeDefined();
      expect(m?.score).toBe(30);
      expect(m?.reason).toBe('no new openings in 14d');
    });

    it('a brand-new company WITH postings still scores — postings are evidence', () => {
      const r = service.compute(
        ctx({
          company: { ...liveOnly, recentJobs14d: 4, probedAt: new Date(), ...brandNew } as never,
        }),
      );
      const m = r.breakdown.find((x) => x.module === 'hiringVelocity');
      expect(m?.score).toBe(75);
    });

    it('a derived growthScore is used at any company age', () => {
      const r = service.compute(
        ctx({
          company: { growthScore: 82, hiringTrend: null, probedAt: new Date(), ...brandNew } as never,
        }),
      );
      expect(r.breakdown.find((x) => x.module === 'hiringVelocity')?.score).toBe(82);
    });
  });

  it('renormalizes: both unknown modules drop together and weights rebalance', () => {
    const both = { confidence: 0, probedAt: null, knownSince: new Date(), growthScore: null, hiringTrend: null };
    const unknown = service.compute(ctx({ company: { ...both, recentJobs14d: 0 } as never }));
    expect(moduleNames(unknown)).not.toContain('companyQuality');
    expect(moduleNames(unknown)).not.toContain('hiringVelocity');

    // An UNPROBED company takes no verification dampening any more, so the
    // reported score is exactly the renormalized blend of surviving modules.
    const weighted = blend(unknown.breakdown.filter((m) => m.weight > 0));
    expect(unknown.opportunityScore).toBeCloseTo(weighted, 1);
  });

});

/**
 * VERIFICATION ≠ OPPORTUNITY (2026-08-13).
 *
 * The verification gate (`confidence < 40` → ×0.85) was the third and largest
 * place the UNKNOWN/BAD conflation lived: ~13 points on a 90-score job, vs the
 * 5-weight companyQuality module. Every aggregator and email-sourced job
 * arrives unprobed, so the old rule measured our own probe backlog as if it
 * were job quality — which would have made new supply look weak on arrival.
 *
 * The two dimensions are now separate:
 *   Opportunity Score → "is this a good job for this person?"
 *   Verification      → "can we safely act on it?"
 *
 * Dampening applies only to EVIDENCE OF ABSENCE (we looked, and found little).
 */
describe('verification is a trust signal, not an opportunity signal', () => {
  const longWatched = { knownSince: new Date(Date.now() - 90 * 86_400_000) };
  const probed = new Date(Date.now() - 86_400_000);

  it('1. unknown company → NO dampening, flagged UNKNOWN, no credit either', () => {
    const unknown = service.compute(
      ctx({ company: { confidence: 0, probedAt: null, ...longWatched } as never }),
    );
    const flag = unknown.breakdown.find((m) => m.module === 'verification');
    expect(flag?.status).toBe('UNKNOWN');
    expect(flag?.weight).toBe(0); // no score effect in EITHER direction
    expect(flag?.reason).toContain('verify before applying');

    // Same job at a fully-verified company: the unknown one must not be
    // penalised for our own probe backlog.
    const verified = service.compute(
      ctx({ company: { confidence: 95, probedAt: probed, ...longWatched } as never }),
    );
    // companyQuality (weight 5) still differs, so allow a small gap — but the
    // ~13-point verification cliff must be gone.
    expect(verified.opportunityScore - unknown.opportunityScore).toBeLessThan(5);
  });

  it('2. verified LOW-confidence company → dampening RETAINED', () => {
    const r = service.compute(
      ctx({ company: { confidence: 15, probedAt: probed, ...longWatched } as never }),
    );
    const flag = r.breakdown.find((m) => m.module === 'verification');
    expect(flag?.status).toBe('FAILED');
    expect(flag?.reason).toContain('verification weak');
  });

  it('3. verified HIGH-confidence company → no flag, no dampening', () => {
    const r = service.compute(
      ctx({ company: { confidence: 95, probedAt: probed, ...longWatched } as never }),
    );
    expect(r.breakdown.find((m) => m.module === 'verification')).toBeUndefined();
  });

  it('4. verification FAILURE scores strictly below an UNKNOWN company', () => {
    const failed = service.compute(
      ctx({ company: { confidence: 5, probedAt: probed, ...longWatched } as never }),
    );
    const unknown = service.compute(
      ctx({ company: { confidence: 0, probedAt: null, ...longWatched } as never }),
    );
    expect(failed.opportunityScore).toBeLessThan(unknown.opportunityScore);
  });

  it('5. unknown company with an EXCELLENT fit still reaches a high score', () => {
    // The FreeHire case: perfect MERN match, company unprobed on arrival.
    // It must be actionable on its merits, with verification pending.
    const r = service.compute(
      ctx({
        match: { overallScore: 95, technicalScore: 95, experienceScore: 95, missingSkills: [] },
        company: { confidence: 0, probedAt: null, knownSince: new Date(), growthScore: null, hiringTrend: null, recentJobs14d: 0 },
      } as never),
    );
    expect(r.opportunityScore).toBeGreaterThan(75); // APPLY territory
    expect(r.breakdown.find((m) => m.module === 'verification')?.status).toBe('UNKNOWN');
  });
});
