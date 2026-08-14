import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';
import { nextOutreachAction } from '../referrals/referral-followup';
import {
  competitionChips,
  greeting,
  impactLabel,
  istHour,
  weekMomentum,
  type Impact,
  type Momentum,
} from './today.pure';

export type TodayKind =
  | 'REPLY'
  | 'FOLLOW_UP'
  | 'APPLY'
  /** Similar to the resume but NOT evaluated — a candidate, not a
   *  recommendation. Kept separate from APPLY so the product never implies a
   *  judgement it has not made. */
  | 'POTENTIAL'
  | 'TAILOR'
  | 'REFERRAL'
  | 'MASTER_RESUME'
  | 'LEARN';

export interface TodayAction {
  kind: TodayKind;
  title: string;
  detail: string;
  chips: string[];
  stars: number; // 1–5, internal ordering only
  impact: Impact; // what the user sees instead of stars
  minutes: number; // estimated effort
  href: string; // into an existing feature
  value?: string; // e.g. "unlocks 6 strong matches"
  why?: string[]; // "why this first" — only on the lead action
  /**
   * The opportunity this action is about, when there is one. Present only for
   * job-bound kinds (APPLY / TAILOR / REFERRAL); MASTER_RESUME, LEARN and the
   * outreach kinds are not about a specific job and correctly omit it.
   *
   * Exists so /today can log SHOWN and CLICKED against a real job — the CTR
   * denominator. `opportunity_events.jobId` is NOT NULL, so without this the
   * surface cannot be measured at all.
   */
  jobId?: string;
  /**
   * The Opportunity Score this action actually puts on screen, when it shows
   * one (APPLY cards render "Opportunity {n}"). This is `browseByFit`'s live
   * score, NOT the persisted verdict in job_matches — the two are separate
   * scoring paths and are known to disagree. Surfaced so analytics can record
   * what was displayed rather than re-deriving a number the user never saw.
   */
  opportunity?: number;
}

// Lower = earlier when priority ties. Time-sensitive replies first; passive
// learning last.
const KIND_ORDER: Record<TodayKind, number> = {
  REPLY: 0,
  FOLLOW_UP: 1,
  APPLY: 2,
  TAILOR: 3,
  REFERRAL: 4,
  // Below the evaluated actions: a real recommendation always outranks a
  // candidate, but above the passive ones so recall stays visible.
  POTENTIAL: 5,
  MASTER_RESUME: 6,
  LEARN: 7,
};

const DAY = 86_400_000;

/**
 * The Today Command Center. A deterministic daily plan that orchestrates the
 * highest-leverage actions across every pillar CareerOS already has — apply,
 * follow up, tailor, refer, learn — ranked, time-estimated, each a link into
 * the feature that does it. Action-first, never metrics-first. No LLM.
 */
@Injectable()
export class TodayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: MatchingService,
  ) {}

  async today(userId: string, name?: string | null) {
    const activeVersion = await this.prisma.resumeVersion.findFirst({
      where: { resume: { userId, isPrimary: true }, activatedAt: { not: null } },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    });
    const activeVersionId = activeVersion?.id ?? null;

    const primaryResume = await this.prisma.resume.findFirst({
      where: { userId, isPrimary: true },
      select: { masterHtml: true },
    });

    const apps = await this.prisma.application.findMany({
      where: { userId },
      select: { jobId: true, status: true },
    });
    const appliedJobIds = new Set(apps.filter((a) => a.status !== 'SAVED').map((a) => a.jobId));
    const applicationsActive = apps.filter((a) =>
      ['APPLIED', 'OA', 'INTERVIEW'].includes(a.status),
    ).length;
    const interviewsInProgress = apps.filter((a) =>
      ['OA', 'INTERVIEW', 'OFFER'].includes(a.status),
    ).length;

    // The feed is a broad candidate pool: mostly jobs that merely LOOK relevant
    // (evaluation coverage is ~1%), plus the few the decision engine has
    // actually judged. Those are different claims and Today must not blur them.
    //
    // Telling the user to "Apply to X" is CareerOS asserting a judgement, so it
    // may only be said about an evaluated APPLY. Until 2026-08-15 this took the
    // whole feed, which is how a job refused as TARGET_ROLE_TOO_SENIOR was
    // presented as "Apply to XO Health — Opportunity 71".
    const feed = await this.matching.browseByFit(userId, { limit: 24 });
    const actionable = feed.items.filter((i) => !i.applied && !appliedJobIds.has(i.jobId));
    const applyCandidates = actionable.filter((i) => i.state === 'APPLY');
    // Strong-looking but unjudged. Surfaced as an explicit pending state so
    // recall survives without dressing a candidate up as a recommendation.
    const potentialCandidates = actionable.filter((i) => i.state === 'POTENTIAL');

    // Missing-skill signal for the LEARN action (the feed doesn't carry it).
    const learnMatches = activeVersionId
      ? await this.prisma.jobMatch.findMany({
          where: { userId, resumeVersionId: activeVersionId, verdict: { in: ['APPLY', 'CONSIDER'] } },
          select: { missingSkills: true },
        })
      : [];

    const contacts = await this.prisma.referralContact.findMany({
      where: { userId },
      select: {
        companyName: true,
        name: true,
        status: true,
        contactedAt: true,
        repliedAt: true,
        followUpCount: true,
        lastFollowUpAt: true,
      },
    });
    const repliesInFlight = contacts.filter((c) => c.status === 'REPLIED').length;
    const outreachInFlight = contacts.filter((c) => c.status === 'CONTACTED').length;

    const tailored = await this.prisma.companyResume.findMany({
      where: { userId },
      select: { jobId: true },
    });
    const tailoredJobs = new Set(tailored.map((t) => t.jobId));

    const actions: Omit<TodayAction, 'impact'>[] = [];

    // 1) Outreach that needs you today — replies to answer, nudges that are due.
    const due = contacts
      .map((c) => ({
        c,
        na: nextOutreachAction({
          status: c.status,
          contactedAt: c.contactedAt,
          repliedAt: c.repliedAt,
          followUpCount: c.followUpCount,
          lastFollowUpAt: c.lastFollowUpAt,
        }),
      }))
      .filter((x) => x.na.due && (x.c.status === 'CONTACTED' || x.c.status === 'REPLIED'))
      .sort((a, b) => b.na.urgency - a.na.urgency)
      .slice(0, 2);
    for (const { c, na } of due) {
      const replied = c.status === 'REPLIED';
      actions.push({
        kind: replied ? 'REPLY' : 'FOLLOW_UP',
        title: replied ? `Reply to ${c.name} at ${c.companyName}` : `Follow up with ${c.name} at ${c.companyName}`,
        detail: na.detail,
        chips: [na.daysSince != null ? `day ${na.daysSince}` : 'today'],
        stars: replied ? 5 : na.urgency >= 3 ? 5 : 4,
        minutes: replied ? 5 : 3,
        href: '/outreach',
      });
    }

    // 2) Apply to your highest-Opportunity-Score EVALUATED jobs. Every card here
    //    carries a real verdict from the decision engine.
    let freshApplyMatches = 0;
    const top = applyCandidates[0] ?? null;
    for (const m of applyCandidates.slice(0, 2)) {
      if (m.ageDays <= 3) freshApplyMatches++;
      // `opportunity` is the canonical stored score; APPLY always carries one.
      const opp = Math.round(m.opportunity ?? 0);
      const chips = [...competitionChips(m.ageDays), `opp ${opp}`];
      if (m.referral !== 'NONE') chips.push('referral in flight');
      if (m.watched) chips.push('★ watchlist');
      if (tailoredJobs.has(m.jobId)) chips.push('resume ready');
      // The explanation is the Opportunity Score's own factors — one shared
      // Recommendation object surfaced everywhere (Today / Browse / Telegram).
      const why = m.factors.filter((f) => f.delta > 0).map((f) => f.label);
      actions.push({
        kind: 'APPLY',
        title: `Apply to ${m.company}`,
        detail: `Opportunity ${opp} · ${m.competition.toLowerCase()} competition — get in while it's fresh.`,
        chips,
        stars: 5,
        minutes: 10,
        href: `/jobs/${m.jobId}`,
        why,
        jobId: m.jobId,
        opportunity: opp,
      });
    }

    // 2b) Potential matches — strong resume similarity, NOT yet evaluated.
    //
    // These keep recall alive while evaluation coverage sits near 1%: without
    // them a day with no evaluated APPLY would render an empty product even
    // though thousands of plausible jobs exist. The wording is deliberately
    // non-committal — CareerOS has not judged these, and says so rather than
    // implying a verdict it has not earned. No Opportunity Score is shown,
    // because none exists.
    if (applyCandidates.length < 3) {
      for (const m of potentialCandidates.slice(0, 3 - applyCandidates.length)) {
        actions.push({
          kind: 'POTENTIAL',
          title: `Review ${m.company} — looks like a fit`,
          detail: `${m.fit}% resume similarity · not evaluated yet — open it to trigger a full assessment.`,
          chips: [...competitionChips(m.ageDays), 'evaluation pending'],
          stars: 3,
          minutes: 4,
          href: `/jobs/${m.jobId}`,
          jobId: m.jobId,
          // Deliberately no `opportunity`: an unevaluated job has no score.
        });
      }
    }

    // 3) Tailor / 4) Referral — for the top apply target, if not done yet.
    if (top) {
      if (!tailoredJobs.has(top.jobId)) {
        actions.push({
          kind: 'TAILOR',
          title: `Tailor your resume for ${top.company}`,
          detail: 'Match the JD keywords (ATS) before you apply — from your real content.',
          chips: ['1 click', 'ATS keywords'],
          stars: 4,
          minutes: 3,
          href: `/resumes/tailor/${top.jobId}`,
          jobId: top.jobId,
        });
      }
      if (top.referral === 'NONE') {
        actions.push({
          kind: 'REFERRAL',
          title: `Find a referral at ${top.company}`,
          detail: 'A warm intro is the single biggest lever on getting seen.',
          chips: ['public sources'],
          stars: 4,
          minutes: 5,
          href: `/referrals/${top.jobId}`,
          jobId: top.jobId,
        });
      }
    }

    // 5) One-time high-value: use your real resume as the master.
    if (activeVersionId && !primaryResume?.masterHtml) {
      actions.push({
        kind: 'MASTER_RESUME',
        title: 'Set your real resume as the master',
        detail: 'Tailored resumes are using a generated copy that loses your formatting & achievements.',
        chips: ['one-time', 'upload .html'],
        stars: 4,
        minutes: 2,
        href: '/resumes/master',
      });
    }

    // 6) Highest-ROI skill to learn — the most common gap across strong matches.
    const skillCounts = new Map<string, number>();
    for (const m of learnMatches) {
      for (const s of m.missingSkills) {
        const k = s.trim();
        if (k) skillCounts.set(k, (skillCounts.get(k) ?? 0) + 1);
      }
    }
    const topSkill = [...skillCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topSkill && topSkill[1] >= 3) {
      actions.push({
        kind: 'LEARN',
        title: `Learn ${topSkill[0]}`,
        detail: 'The most common missing requirement across your strong matches.',
        chips: ['high ROI'],
        value: `unlocks ${topSkill[1]} strong matches`,
        stars: 3,
        minutes: 120,
        href: '/insights',
      });
    }

    actions.sort((a, b) => b.stars - a.stars || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    const ranked: TodayAction[] = actions
      .slice(0, 7)
      .map((a, i) => ({ ...a, impact: impactLabel(a.stars, i === 0) }));

    const momentum = weekMomentum({
      interviewsInProgress,
      repliesInFlight,
      outreachInFlight,
      freshApplyMatches,
      applicationsActive,
    });

    // Today's goal: get one application in. Progress people can feel.
    const istMs = Date.now() + 5.5 * 3_600_000;
    const startOfTodayUtc = new Date(Math.floor(istMs / DAY) * DAY - 5.5 * 3_600_000);
    const appliedToday = await this.prisma.application.count({
      where: { userId, appliedAt: { gte: startOfTodayUtc } },
    });

    return {
      greeting: greeting(istHour()),
      name: name ?? null,
      goal: { label: 'Get one application submitted today', done: appliedToday, target: 1 },
      weekProbability: momentum.level as Momentum,
      probabilityReason: momentum.reason,
      totalMinutes: ranked.reduce((n, a) => n + a.minutes, 0),
      actions: ranked,
    };
  }
}
