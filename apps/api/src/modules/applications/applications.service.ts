import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  funnelInsights,
  likelyCauses,
  waitingActions,
  type AppSignals,
} from './application-intelligence';

/**
 * The application tracker (ROADMAP v0.3): makes "Applied" — the north-star
 * metric — measurable, and collects the outcome data every v1.0 intelligence
 * feature (follow-up nudges, resume analytics, honest interview odds) needs.
 * Every status change is an append-only ApplicationEvent.
 */
@Injectable()
export class ApplicationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * "I applied" / "save for later" from a job card. Idempotent per (user,job):
   * repeat calls transition the existing application instead of duplicating.
   */
  async createFromJob(
    userId: string,
    jobId: string,
    opts: { status?: ApplicationStatus; note?: string; source?: string } = {},
  ) {
    const job = await this.prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!job) throw new NotFoundException('Job not found');

    const status = opts.status ?? ApplicationStatus.APPLIED;
    const existing = await this.prisma.application.findUnique({
      where: { userId_jobId: { userId, jobId } },
    });
    if (existing) return this.transition(userId, existing.id, status, opts.note);

    // Which resume version applied — the outcome-learning foundation. Must be
    // the ACTIVATED version: an uploaded-but-unconfirmed draft never went out.
    const primary = await this.prisma.resumeVersion.findFirst({
      where: { resume: { userId, isPrimary: true }, activatedAt: { not: null } },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    });

    return this.prisma.application.create({
      data: {
        userId,
        jobId,
        status,
        notes: opts.note,
        appliedAt: status === ApplicationStatus.APPLIED ? new Date() : null,
        resumeVersionId: primary?.id,
        source: opts.source ?? 'careeros-match',
        events: { create: { toStatus: status, note: opts.note } },
      },
      include: { job: { select: { title: true } } },
    });
  }

  async transition(
    userId: string,
    applicationId: string,
    toStatus: ApplicationStatus,
    note?: string,
  ) {
    const app = await this.prisma.application.findUnique({ where: { id: applicationId } });
    if (!app || app.userId !== userId) throw new NotFoundException('Application not found');
    if (app.status === toStatus && !note) {
      throw new BadRequestException(`Already ${toStatus}`);
    }

    return this.prisma.application.update({
      where: { id: applicationId },
      data: {
        status: toStatus,
        ...(toStatus === ApplicationStatus.APPLIED && !app.appliedAt
          ? { appliedAt: new Date() }
          : {}),
        events: { create: { fromStatus: app.status, toStatus, note } },
      },
      include: { job: { select: { title: true } } },
    });
  }

  list(userId: string, status?: ApplicationStatus) {
    return this.prisma.application.findMany({
      where: { userId, ...(status ? { status } : {}) },
      orderBy: { updatedAt: 'desc' },
      include: {
        job: {
          select: {
            title: true,
            url: true,
            location: true,
            company: { select: { name: true } },
          },
        },
        events: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    });
  }

  async stats(userId: string) {
    const rows = await this.prisma.application.groupBy({
      by: ['status'],
      where: { userId },
      _count: { _all: true },
    });
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    const applied =
      (byStatus.APPLIED ?? 0) +
      (byStatus.OA ?? 0) +
      (byStatus.INTERVIEW ?? 0) +
      (byStatus.OFFER ?? 0) +
      (byStatus.ACCEPTED ?? 0) +
      (byStatus.REJECTED ?? 0);
    const interviews =
      (byStatus.INTERVIEW ?? 0) + (byStatus.OFFER ?? 0) + (byStatus.ACCEPTED ?? 0);

    return {
      byStatus,
      applied,
      interviews,
      offers: (byStatus.OFFER ?? 0) + (byStatus.ACCEPTED ?? 0),
      // Honest rate: needs volume before it means anything; null under 5.
      interviewRate: applied >= 5 ? Math.round((interviews / applied) * 100) : null,
    };
  }

  /**
   * Application Intelligence: per-application next-actions (while live) and
   * likely causes (after rejection / long silence), plus honest portfolio
   * insights — all from data we already store. No LLM, no fabricated numbers.
   */
  async intelligence(userId: string) {
    const stats = await this.stats(userId);
    const apps = await this.prisma.application.findMany({
      where: { userId, status: { not: ApplicationStatus.SAVED } },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        jobId: true,
        status: true,
        appliedAt: true,
        job: {
          select: { id: true, firstSeenAt: true, company: { select: { name: true } } },
        },
      },
    });
    if (apps.length === 0) return { funnel: stats, insights: [], items: [] };

    const jobIds = apps.map((a) => a.jobId);
    const companyNames = [...new Set(apps.map((a) => a.job.company.name))];

    const version = await this.prisma.resumeVersion.findFirst({
      where: { resume: { userId, isPrimary: true }, activatedAt: { not: null } },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, confirmedProfile: true },
    });
    const userYears =
      (version?.confirmedProfile as { totalYearsExperience?: number } | null)
        ?.totalYearsExperience ?? null;

    const matches = version?.id
      ? await this.prisma.jobMatch.findMany({
          where: { userId, resumeVersionId: version.id, jobId: { in: jobIds } },
          select: { jobId: true, missingSkills: true, specializationFit: true },
        })
      : [];
    const matchByJob = new Map(matches.map((m) => [m.jobId, m]));

    const classes = await this.prisma.jobClassification.findMany({
      where: { jobId: { in: jobIds } },
      orderBy: { classifierVersion: 'desc' },
      select: { jobId: true, minimumYears: true },
    });
    const minYearsByJob = new Map<string, number | null>();
    for (const c of classes) if (!minYearsByJob.has(c.jobId)) minYearsByJob.set(c.jobId, c.minimumYears);

    const contacted = await this.prisma.referralContact.findMany({
      where: { userId, companyName: { in: companyNames }, status: { in: ['CONTACTED', 'REPLIED'] } },
      select: { companyName: true },
    });
    const contactedCompanies = new Set(contacted.map((c) => c.companyName));

    const tailored = await this.prisma.companyResume.findMany({
      where: { userId, jobId: { in: jobIds } },
      select: { jobId: true },
    });
    const tailoredJobs = new Set(tailored.map((t) => t.jobId));

    const DAY = 86_400_000;
    let withReferral = 0;
    let tailoredCount = 0;
    const items = apps.map((a) => {
      const match = matchByJob.get(a.jobId);
      const hadReferralContact = contactedCompanies.has(a.job.company.name);
      const tailoredResume = tailoredJobs.has(a.jobId);
      if (hadReferralContact) withReferral++;
      if (tailoredResume) tailoredCount++;
      const daysSinceApplied = a.appliedAt
        ? Math.floor((Date.now() - a.appliedAt.getTime()) / DAY)
        : null;
      const jobAgeAtApplyDays = a.appliedAt
        ? Math.max(0, Math.floor((a.appliedAt.getTime() - a.job.firstSeenAt.getTime()) / DAY))
        : null;
      const signals: AppSignals = {
        status: a.status,
        daysSinceApplied,
        jobAgeAtApplyDays,
        userYears,
        minimumYears: minYearsByJob.get(a.jobId) ?? null,
        missingRequired: match?.missingSkills ?? [],
        specializationFit: match?.specializationFit ?? null,
        hadReferralContact,
        tailoredResume,
      };
      const terminal = a.status === 'REJECTED' || a.status === 'WITHDRAWN';
      const ghosted = a.status === 'APPLIED' && (daysSinceApplied ?? 0) >= 21;
      return {
        applicationId: a.id,
        jobId: a.jobId,
        status: a.status,
        hadReferralContact,
        tailoredResume,
        waitingActions: terminal ? [] : waitingActions(signals, a.jobId),
        likelyCauses: terminal || ghosted ? likelyCauses(signals) : [],
      };
    });

    const insights = funnelInsights({
      applied: stats.applied,
      withReferral,
      tailored: tailoredCount,
      interviews: stats.interviews,
    });
    return { funnel: stats, insights, items };
  }

  /** Applications sitting in APPLIED with no movement — the follow-up nudge. */
  followUpsDue(userId: string, days = 7) {
    return this.prisma.application.findMany({
      where: {
        userId,
        status: ApplicationStatus.APPLIED,
        appliedAt: { lte: new Date(Date.now() - days * 86_400_000) },
      },
      orderBy: { appliedAt: 'asc' },
      take: 5,
      include: {
        job: { select: { title: true, company: { select: { name: true } } } },
      },
    });
  }
}

export { ApplicationStatus };
export type ApplicationWithJob = Prisma.ApplicationGetPayload<{
  include: { job: { select: { title: true } } };
}>;
