import { Injectable } from '@nestjs/common';
import { HiringTrend, JobStatus, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { decide } from '../notifications/decision';
import {
  actionFor,
  DEFAULT_ROLE_PROFILE,
  eligibility,
  type Eligibility,
  type JobClassification,
} from '../matching/role-classification';
import { PIPELINE_DECISION_VERSION } from '../matching/pipeline-version';
import { companyTier, isEvergreen } from './company-tier';
import { SourceTrustService } from '../source-trust/source-trust.service';

/**
 * Deep-scored decisions stamp the SAME canonical version as gate refusals.
 *
 * This used to be a private `DECISION_VERSION = 1` while the candidate query
 * excluded on `>= CLASSIFIER_VERSION` (2), so every job that survived the gate
 * and cost an LLM call was re-admitted on the very next tick — forever. Bump
 * decide()'s logic by raising PIPELINE_DECISION_VERSION, not by adding a
 * second constant here.
 */

/**
 * Opportunity Score (ADR-10): modular scorers, each returning a 0-100 score,
 * its weight, and a human reason. Non-applicable modules (no data) drop out
 * and remaining weights renormalize — an unknown salary must not silently
 * drag a score down. The breakdown ships with every notification:
 * CareerOS explains, it doesn't just rank.
 */

export interface ScoreModule {
  module: string;
  score: number; // 0-100
  weight: number;
  reason: string;
  /** Trust dimension, set only by the `verification` module. UNKNOWN carries
   *  no score effect — it tells the action layer to verify before applying,
   *  rather than pretending the opportunity is worse than it is. */
  status?: 'UNKNOWN' | 'FAILED';
}

/**
 * Read the modules out of a persisted `scoreBreakdown`, whichever shape it is
 * in. The column holds two: the flat `ScoreModule[]` this service writes, and
 * the `{ modules, notifiedScore }` envelope the notifier wraps around it to
 * remember which score it last announced.
 *
 * Both are live in the corpus (measured 2026-08-21: 831 flat, 31 wrapped — and
 * every wrapped one is an APPLY, because only APPLY notifies). So each consumer
 * must normalize, and must do it HERE rather than inline: `?? []` guards null
 * but not a non-array, so a wrapped breakdown reached `for (const m of ...)`
 * and crashed /analytics/quality and /analytics/signals with "object is not
 * iterable" the moment the first real outcome was logged. Those surfaces
 * returned 200 while the tables were empty and 500 once they had something to
 * show — an emptiness that looked like health.
 */
export function readScoreModules(raw: unknown): ScoreModule[] {
  if (Array.isArray(raw)) return raw as ScoreModule[];
  const nested = (raw as { modules?: unknown } | null)?.modules;
  return Array.isArray(nested) ? (nested as ScoreModule[]) : [];
}

export interface OpportunityResult {
  opportunityScore: number;
  breakdown: ScoreModule[];
  contentHash: string;
}

interface ScoringContext {
  match: {
    overallScore: number;
    technicalScore: number;
    experienceScore: number;
    missingSkills: string[];
  };
  job: {
    title: string;
    location: string | null;
    postedAt: Date | null;
    firstSeenAt: Date;
    workMode: string | null;
    salaryMin: number | null;
    salaryMax: number | null;
    currency: string | null;
    companyId: string;
    source: string | null;
    sourceTrust: number | null; // 0-100 trust of the ingest source; null = unknown
  };
  prefs: {
    workModes: string[];
    minSalary: number | null;
    salaryCurrency: string | null;
    cities: string[];
  } | null;
  company: {
    name: string;
    confidence: number;
    /** When the discovery prober last visited. NULL = never measured, so
     *  `confidence` carries no evidence either way. */
    probedAt: Date | null;
    /** When this company entered the corpus — the start of our observation
     *  window. Shorter than 14 days means the 14-day activity signal is
     *  unobserved, not absent. */
    knownSince: Date | null;
    hiringTrend: HiringTrend | null;
    /** Jobs this company added in the last 14 days — live hiring activity. */
    recentJobs14d: number;
    /** Phase 5 deterministic hiring-momentum score (0-100), null if not derived. */
    growthScore: number | null;
  };
}

/** The 14-day activity signal is only evidence once we have watched 14 days. */
const ACTIVITY_WINDOW_DAYS = 14;

const WEIGHTS = {
  resumeFit: 35,
  experienceFit: 15,
  freshness: 20, // raised 15→20 (2026-07-08): 70d-old postings were reading "High"
  remotePreference: 10,
  salaryPreference: 5,
  companyQuality: 5,
  hiringVelocity: 5,
  cityPreference: 5, // boost-only module — added only on a match
  skillGap: 5,
} as const;

@Injectable()
export class OpportunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sourceTrust: SourceTrustService,
  ) {}

  /** Compute + persist the opportunity score for one JobMatch. */
  async scoreMatch(matchId: string): Promise<OpportunityResult | null> {
    const match = await this.prisma.jobMatch.findUnique({
      where: { id: matchId },
      include: {
        job: { include: { company: { include: { intelligence: true } } } },
        user: { include: { preference: true } },
      },
    });
    if (!match || match.job.status !== JobStatus.ACTIVE) return null;

    const sourceTrust = await this.sourceTrust.trustFor(match.job.source);

    const result = this.compute({
      match: {
        overallScore: match.overallScore,
        technicalScore: match.technicalScore,
        experienceScore: match.experienceScore,
        missingSkills: match.missingSkills,
      },
      job: {
        title: match.job.title,
        location: match.job.location,
        postedAt: match.job.postedAt,
        firstSeenAt: match.job.firstSeenAt,
        workMode: match.job.workMode,
        salaryMin: match.job.salaryMin,
        salaryMax: match.job.salaryMax,
        currency: match.job.currency,
        companyId: match.job.companyId,
        source: match.job.source,
        sourceTrust,
      },
      prefs: match.user.preference
        ? {
            workModes: match.user.preference.workModes,
            minSalary: match.user.preference.minSalary,
            salaryCurrency: match.user.preference.salaryCurrency,
            cities: match.user.preference.cities,
          }
        : null,
      company: {
        name: match.job.company.name,
        confidence: match.job.company.confidence,
        // Absence of evidence vs evidence of absence. A company the prober has
        // never visited has confidence 0 because nothing was measured — not
        // because it failed. `lastProbedAt` is the only field that separates
        // the two, so the scorer needs it to avoid scoring UNKNOWN as BAD.
        probedAt: match.job.company.lastProbedAt,
        // How long we have actually been watching. A company discovered three
        // hours ago cannot have "no new openings in 14 days" — we did not
        // observe the window.
        knownSince: match.job.company.createdAt,
        hiringTrend: match.job.company.intelligence?.hiringTrend ?? null,
        growthScore: match.job.company.intelligence?.growthScore ?? null,
        // Prefer postedAt: firstSeenAt spikes on a company's FIRST crawl
        // (whole board looks "new"), inflating the hiring-activity signal.
        recentJobs14d: await this.prisma.job.count({
          where: {
            companyId: match.job.companyId,
            OR: [
              { postedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
              { postedAt: null, firstSeenAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
            ],
          },
        }),
      },
    });

    // The canonical decision, computed once and stored. Role eligibility comes
    // from the JD classification and no score module can overturn it.
    const elig = await this.eligibilityFor(match.jobId, match.userId);
    const ageDays = Math.floor(
      (Date.now() - (match.job.postedAt ?? match.job.firstSeenAt).getTime()) / 86_400_000,
    );
    const tier = companyTier(match.job.company.name);
    const decision = decide({
      opportunityScore: result.opportunityScore,
      resumeMatch: match.overallScore,
      missingSkills: match.missingSkills,
      modules: result.breakdown,
      eligibility: elig ?? undefined,
      ageDays,
      evergreen: isEvergreen(tier),
      activelyHiring: (match.job.company.intelligence?.activeJobs ?? 0) >= 3,
    });

    await this.prisma.jobMatch.update({
      where: { id: matchId },
      data: {
        opportunityScore: result.opportunityScore,
        scoreBreakdown: result.breakdown as unknown as Prisma.InputJsonValue,
        contentHash: result.contentHash,
        verdict: decision.verdict,
        verdictCode: decision.code,
        // All reasons, newline-joined: consumers render them, none recompute them.
        verdictReason: decision.reasons.join('\n') || null,
        roleRelevance: elig?.roleRelevance ?? null,
        developmentConfidence: elig?.developmentConfidence ?? null,
        targetRoleFit: elig?.targetRoleFit ?? null,
        specializationFit: elig?.specializationFit ?? null,
        actionRecommendation: elig
          ? actionFor({
              verdict: decision.verdict,
              targetRoleFit: elig.targetRoleFit,
              specializationFit: elig.specializationFit,
              resumeFit: match.overallScore,
              fit: elig.fit,
              capsAtConsider: elig.capsAtConsider,
            })
          : 'SKIP',
        decisionVersion: PIPELINE_DECISION_VERSION,
        decidedAt: new Date(),
      },
    });
    return result;
  }

  /**
   * Role eligibility for this user, derived from the job's stored objective
   * classification. An unclassified job is never eligible: a job CareerOS has
   * not read cannot be recommended.
   */
  private async eligibilityFor(jobId: string, userId: string): Promise<Eligibility | null> {
    const c = await this.prisma.jobClassification.findFirst({
      where: { jobId },
      orderBy: { classifierVersion: 'desc' },
    });
    if (!c) return null;

    const version = await this.prisma.resumeVersion.findFirst({
      where: { resume: { userId, isPrimary: true }, activatedAt: { not: null } },
      orderBy: { versionNumber: 'desc' },
      select: { confirmedProfile: true, parsedJson: true },
    });
    const confirmed = version?.confirmedProfile as
      | { totalYearsExperience?: number; skills?: string[] }
      | null;
    const parsed = version?.parsedJson as {
      structured?: { totalYearsExperience?: number; skills?: { name: string }[] };
    } | null;

    const years =
      confirmed?.totalYearsExperience ?? parsed?.structured?.totalYearsExperience ?? 2;
    // Specialization fit is measured against the skills the user confirmed,
    // not a stack hardcoded in this file.
    const skills =
      confirmed?.skills ?? parsed?.structured?.skills?.map((s) => s.name) ?? undefined;

    return eligibility(
      {
        primaryFunction: c.primaryFunction as JobClassification['primaryFunction'],
        roleFamily: c.roleFamily as JobClassification['roleFamily'],
        specialization: c.specializations,
        codingIntensity: c.codingIntensity as JobClassification['codingIntensity'],
        developmentConfidence: c.developmentConfidence,
        seniority: c.seniority as JobClassification['seniority'],
        minimumYears: c.minimumYears,
        maximumYears: c.maximumYears,
        requiredSkills: c.requiredSkills,
        preferredSkills: c.preferredSkills,
        responsibilities: c.responsibilities,
        developmentEvidence: c.developmentEvidence,
        nonDevelopmentEvidence: c.nonDevelopmentEvidence,
        classificationReason: c.classificationReason,
      },
      { ...DEFAULT_ROLE_PROFILE, yearsExperience: Math.round(years), skills },
    );
  }

  compute(ctx: ScoringContext): OpportunityResult {
    const modules: ScoreModule[] = [];

    // 1. Resume fit — the LLM's overall verdict carries the most weight.
    modules.push({
      module: 'resumeFit',
      score: ctx.match.overallScore,
      weight: WEIGHTS.resumeFit,
      reason: `${Math.round(ctx.match.overallScore)}% resume match`,
    });

    // 2. Experience fit — seniority mismatches waste applications.
    modules.push({
      module: 'experienceFit',
      score: ctx.match.experienceScore,
      weight: WEIGHTS.experienceFit,
      reason:
        ctx.match.experienceScore >= 70
          ? 'experience level fits'
          : ctx.match.experienceScore >= 40
            ? 'experience level is a stretch'
            : 'seniority mismatch',
    });

    // 3. Freshness — applying within 48h measurably raises response rates.
    // Steep by design: a 60d-old posting is probably in late stages or a
    // zombie listing; it must not compete with this week's openings.
    const seen = ctx.job.postedAt ?? ctx.job.firstSeenAt;
    const ageHours = (Date.now() - seen.getTime()) / 3_600_000;
    const ageDays = ageHours / 24;
    const freshScore =
      ageHours <= 24 ? 100
      : ageDays <= 2 ? 95
      : ageDays <= 3 ? 90
      : ageDays <= 7 ? 80
      : ageDays <= 14 ? 65
      : ageDays <= 21 ? 50
      : ageDays <= 30 ? 35
      : ageDays <= 45 ? 20
      : ageDays <= 60 ? 10
      : 0;
    modules.push({
      module: 'freshness',
      score: freshScore,
      weight: WEIGHTS.freshness,
      reason:
        ageHours <= 1
          ? 'posted minutes ago'
          : ageHours <= 24
            ? `posted ${Math.round(ageHours)}h ago`
            : `posted ${Math.round(ageHours / 24)}d ago`,
    });

    // 4. Remote preference — only when the user stated one AND the job says.
    if (ctx.prefs?.workModes?.length && ctx.job.workMode) {
      const fits = ctx.prefs.workModes.includes(ctx.job.workMode);
      modules.push({
        module: 'remotePreference',
        score: fits ? 100 : 25,
        weight: WEIGHTS.remotePreference,
        reason: fits
          ? `${ctx.job.workMode.toLowerCase()} — matches your preference`
          : `${ctx.job.workMode.toLowerCase()} — outside your preference`,
      });
    }

    // 5. Salary preference — only when both sides disclose.
    if (ctx.prefs?.minSalary && ctx.job.salaryMax) {
      const sameCurrency =
        !ctx.prefs.salaryCurrency ||
        !ctx.job.currency ||
        ctx.prefs.salaryCurrency === ctx.job.currency;
      if (sameCurrency) {
        const meets = ctx.job.salaryMax >= ctx.prefs.minSalary;
        modules.push({
          module: 'salaryPreference',
          score: meets ? 100 : 30,
          weight: WEIGHTS.salaryPreference,
          reason: meets
            ? `salary up to ${ctx.job.currency ?? ''} ${ctx.job.salaryMax.toLocaleString()} meets your floor`
            : 'disclosed salary below your floor',
        });
      }
    }

    // 6. Company quality — discovery confidence, floored for curated big tech.
    //
    // UNKNOWN ≠ LOW. `computeConfidence` starts at 0 and ADDS per positive
    // signal, so a company the prober has never visited is indistinguishable
    // from one that failed every check. Scoring that 0 is inventing negative
    // evidence — it cost board-sourced India jobs up to 6.3 points and flipped
    // 7 of 15 audited matches from CONSIDER to SKIP (2026-08-12 audit).
    // A curated big-tech name is evidence in itself, so it still scores.
    const tier = companyTier(ctx.company.name);
    const companyMeasured = ctx.company.probedAt !== null;
    if (tier === 'BIG_TECH') {
      modules.push({
        module: 'companyQuality',
        score: Math.max(ctx.company.confidence, 85),
        weight: WEIGHTS.companyQuality,
        reason: `big tech (${ctx.company.name})`,
      });
    } else if (companyMeasured) {
      // Probed: whatever the confidence is, it is a real measurement — a low
      // score here is evidence of absence and must keep dragging.
      modules.push({
        module: 'companyQuality',
        score: ctx.company.confidence,
        weight: WEIGHTS.companyQuality,
        reason: `company confidence ${Math.round(ctx.company.confidence)}/100`,
      });
    }
    // else: never probed → module drops out, remaining weights renormalize.

    // 7. Hiring velocity — a growing team reads more applications. Prefer the
    // Phase-5 deterministic growth score (scale + frequency + momentum + recency,
    // refreshed daily for the whole corpus); fall back to the derived trend, then
    // to the LIVE 14-day signal, so this module never silently drops out.
    if (ctx.company.growthScore != null) {
      modules.push({
        module: 'hiringVelocity',
        score: ctx.company.growthScore,
        weight: WEIGHTS.hiringVelocity,
        reason:
          ctx.company.growthScore >= 70
            ? `strong hiring momentum (${ctx.company.growthScore}/100)`
            : ctx.company.growthScore >= 40
              ? `moderate hiring momentum (${ctx.company.growthScore}/100)`
              : `low hiring momentum (${ctx.company.growthScore}/100)`,
      });
    } else if (ctx.company.hiringTrend && ctx.company.hiringTrend !== HiringTrend.INSUFFICIENT_DATA) {
      const score =
        ctx.company.hiringTrend === HiringTrend.GROWING
          ? 100
          : ctx.company.hiringTrend === HiringTrend.STABLE
            ? 60
            : 25;
      modules.push({
        module: 'hiringVelocity',
        score,
        weight: WEIGHTS.hiringVelocity,
        reason: `hiring trend: ${ctx.company.hiringTrend.toLowerCase()}`,
      });
    } else {
      // Live 14-day fallback. "No new openings in 14d" is only a finding if we
      // WATCHED for 14 days — a company discovered three hours ago scores 0
      // by construction, which is unobserved, not quiet. Seeing postings is
      // still evidence at any age (they exist), so only the zero case is gated.
      const recent = ctx.company.recentJobs14d;
      const observedDays = ctx.company.knownSince
        ? (Date.now() - ctx.company.knownSince.getTime()) / 86_400_000
        : 0;
      const windowObserved = observedDays >= ACTIVITY_WINDOW_DAYS;
      if (recent > 0 || windowObserved) {
        modules.push({
          module: 'hiringVelocity',
          score: recent >= 10 ? 95 : recent >= 3 ? 75 : recent >= 1 ? 55 : 30,
          weight: WEIGHTS.hiringVelocity,
          reason:
            recent >= 3
              ? `actively hiring — ${recent} new roles in 14d`
              : recent >= 1
                ? `${recent} new role(s) in 14d`
                : 'no new openings in 14d',
        });
      }
      // else: window not yet observed → module drops out and renormalizes.
    }

    // 7b. City preference — boost only, never penalize (location is often
    // missing or generic; absence of a match must not drag the score).
    if (ctx.prefs?.cities?.length && ctx.job.location) {
      const loc = ctx.job.location.toLowerCase();
      const hit = ctx.prefs.cities.find((c) => loc.includes(c.toLowerCase()));
      if (hit) {
        modules.push({
          module: 'cityPreference',
          score: 100,
          weight: WEIGHTS.cityPreference,
          reason: `in your preferred city (${hit})`,
        });
      }
    }

    // 8. Skill gap — a couple of missing skills is normal; many is a wall.
    const gaps = ctx.match.missingSkills.length;
    modules.push({
      module: 'skillGap',
      score: gaps === 0 ? 100 : gaps <= 2 ? 70 : gaps <= 4 ? 40 : 15,
      weight: WEIGHTS.skillGap,
      reason:
        gaps === 0
          ? 'no missing skills'
          : `missing: ${ctx.match.missingSkills.slice(0, 3).join(', ')}${gaps > 3 ? '…' : ''}`,
    });

    const totalWeight = modules.reduce((s, m) => s + m.weight, 0);
    let opportunityScore =
      Math.round(
        (modules.reduce((s, m) => s + m.score * m.weight, 0) / totalWeight) * 10,
      ) / 10;

    // Source reliability nudge (bounded ±4 around a 92 baseline, applied like the
    // verification gate — a direct adjustment, not a weighted module — so it
    // doesn't dilute the renormalized blend). A top-tier ATS edges out an equal
    // job from a noisier source; a stale-heavy source is gently discounted.
    if (ctx.job.sourceTrust != null) {
      const nudge = Math.max(-4, Math.min(3, Math.round((ctx.job.sourceTrust - 92) / 4)));
      if (nudge !== 0) {
        opportunityScore = Math.max(0, Math.min(100, Math.round((opportunityScore + nudge) * 10) / 10));
      }
      modules.push({
        module: 'sourceReliability',
        score: ctx.job.sourceTrust,
        weight: 0, // informational — the nudge already applied
        reason: `${ctx.job.source ?? 'source'} reliability ${ctx.job.sourceTrust}/100${
          nudge !== 0 ? ` (${nudge > 0 ? '+' : ''}${nudge})` : ''
        }`,
      });
    }

    // Verification is a TRUST dimension, not an OPPORTUNITY dimension.
    //
    //   Opportunity Score → "is this a good job for this person?"
    //   Verification      → "can we safely act on it?"
    //
    // Conflating them meant a never-probed company lost ~13 points on a
    // 90-score job — measuring our own probe backlog as if it were job
    // quality. Every aggregator/email job arrives unprobed, so that would
    // have made new supply look weak on arrival (2026-08-13).
    //
    // The dampening now applies ONLY to evidence of absence: we looked, and
    // what we found was thin. Never looked → no penalty, no credit, flagged.
    const verificationMeasured = ctx.company.probedAt !== null;
    if (!verificationMeasured) {
      modules.push({
        module: 'verification',
        score: 0,
        weight: 0, // informational — carries NO score effect in either direction
        status: 'UNKNOWN',
        reason: 'company not yet verified — verify before applying',
      });
    } else if (ctx.company.confidence < 40) {
      opportunityScore = Math.round(opportunityScore * 0.85 * 10) / 10;
      modules.push({
        module: 'verification',
        score: ctx.company.confidence,
        weight: 0, // informational — the dampening already applied
        status: 'FAILED',
        reason: `⚠ company verification weak (confidence ${Math.round(ctx.company.confidence)}/100) — score reduced`,
      });
    }
    // else: probed and confident → no flag, no dampening (unchanged).

    const contentHash = createHash('sha256')
      .update(`${ctx.job.title}|${ctx.job.salaryMin}|${ctx.job.salaryMax}`)
      .digest('hex')
      .slice(0, 16);

    return { opportunityScore, breakdown: modules, contentHash };
  }
}
