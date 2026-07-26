import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DiscoveryStage, HiringTrend, JobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LLM_PROVIDER } from '../ai/llm.provider';
import type { LlmProvider } from '../ai/llm.provider';
import { companyGrowthScore, trendFrom, type Trend } from './company-growth';

interface ExtractedProfile {
  techStack: string[];
  remoteFriendly: boolean | null;
  visaMentioned: boolean | null;
  hiresJuniors: boolean | null;
  avgExperienceReq: number | null;
  roleMix: Record<string, number>;
}

const EXTRACT_PROMPT = `You are profiling ONE employer from a sample of its job postings.
Analyze ALL postings together and return JSON:
{"techStack":[string],"remoteFriendly":boolean|null,"visaMentioned":boolean|null,"hiresJuniors":boolean|null,"avgExperienceReq":number|null,"roleMix":{"backend":number,"frontend":number,"fullstack":number,"ai":number,"devops":number,"mobile":number,"data":number,"other":number}}
Rules:
- techStack: up to 20 technologies actually named in postings, normalized lowercase ("react", "node.js", "postgresql", "aws"). Not soft skills.
- remoteFriendly: true if remote roles are common; false if explicitly office-bound; null if unclear.
- visaMentioned: true only if visa sponsorship/relocation support is explicitly offered anywhere.
- hiresJuniors: true if any role asks <= 2 years experience or says junior/entry/graduate.
- avgExperienceReq: average of the MINIMUM years asked across postings that state one; null if none do.
- roleMix: count each posting into exactly one bucket.`;

/** ≥ this many days of monitoring before velocity/trend claims mean anything. */
const MIN_HISTORY_DAYS = 14;

@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  /** Build/refresh the intelligence profile for one company. */
  async deriveForCompany(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        jobs: {
          where: { status: JobStatus.ACTIVE },
          orderBy: { firstSeenAt: 'desc' },
          take: 15,
          select: { title: true, description: true },
        },
      },
    });
    if (!company) throw new NotFoundException('Company not found');
    if (company.jobs.length === 0) {
      this.logger.warn(`${company.name}: no active jobs — skipping intelligence derivation`);
      return null;
    }

    // 1. LLM extraction over our own corpus — no external requests at all.
    const sample = company.jobs
      .map((j, i) => `--- POSTING ${i + 1}: ${j.title}\n${j.description.slice(0, 2_500)}`)
      .join('\n\n');
    const profile = await this.llm.generateJson<ExtractedProfile>(
      `${EXTRACT_PROMPT}\n\nEMPLOYER: ${company.name}\n\n${sample}`,
    );

    // 2. SQL aggregates from data we already store.
    const [salary] = await this.prisma.$queryRaw<
      { min_median: number | null; max_median: number | null }[]
    >`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY "salaryMin")::int AS min_median,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY "salaryMax")::int AS max_median
      FROM jobs
      WHERE "companyId" = ${companyId} AND status = 'ACTIVE' AND "salaryMin" IS NOT NULL
    `;
    const activeJobs = await this.prisma.job.count({
      where: { companyId, status: JobStatus.ACTIVE },
    });
    const velocity = await this.hiringVelocity(companyId);

    const data = {
      techStack: (profile.techStack ?? []).slice(0, 20).map((t) => t.toLowerCase()),
      remoteFriendly: profile.remoteFriendly,
      visaMentioned: profile.visaMentioned,
      hiresJuniors: profile.hiresJuniors,
      avgExperienceReq: profile.avgExperienceReq,
      roleMix: (profile.roleMix ?? {}) as Prisma.InputJsonValue,
      salaryMinMedian: salary?.min_median ?? null,
      salaryMaxMedian: salary?.max_median ?? null,
      activeJobs,
      hiringVelocity: velocity.months as unknown as Prisma.InputJsonValue,
      hiringTrend: velocity.trend,
      derivedAt: new Date(),
    };

    await this.prisma.companyIntelligence.upsert({
      where: { companyId },
      create: { companyId, ...data },
      update: data,
    });
    this.logger.log(
      `${company.name}: intel derived (${data.techStack.length} techs, trend ${velocity.trend})`,
    );
    return data;
  }

  /** Companies with jobs but stale/missing intelligence (weekly refresh). */
  async deriveDueCompanies(limit = 10): Promise<number> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const due = await this.prisma.company.findMany({
      where: {
        discoveryStage: DiscoveryStage.MONITORED,
        jobs: { some: { status: JobStatus.ACTIVE } },
        OR: [{ intelligence: null }, { intelligence: { derivedAt: { lt: weekAgo } } }],
      },
      take: limit,
      select: { id: true },
    });
    let done = 0;
    for (const c of due) {
      try {
        await this.deriveForCompany(c.id);
        done++;
        await new Promise((r) => setTimeout(r, 8_000)); // free-tier LLM pacing
      } catch (err) {
        this.logger.warn(`intel derivation failed for ${c.id}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      }
    }
    return done;
  }

  /**
   * Phase 5 — the fast, deterministic company-signal pass. For EVERY monitored
   * company with live jobs, compute hiring frequency, momentum, department mix,
   * recency, referral density and a 0-100 growth score from data we already
   * store — all SQL, no LLM, so the whole corpus refreshes daily (the LLM
   * profiler only ever reaches ~10/week). Field ownership is clean: this pass
   * owns the cheap facts (activeJobs, hiringTrend, growthScore, newRoles30d,
   * departmentsHiring, referralContacts, lastJobAt); the LLM pass owns techStack/
   * roleMix/salary and never has them clobbered here.
   */
  async deriveSignalsCorpus(limit = 2000): Promise<{ companies: number }> {
    // One grouped pass over jobs: scale, two 30-day windows, recency, history,
    // and a department breakdown by title — per company, in a single query.
    const rows = await this.prisma.$queryRaw<
      Array<{
        companyId: string;
        active: bigint;
        new30: bigint;
        prev30: bigint;
        last_job: Date | null;
        first_job: Date | null;
        backend: bigint;
        frontend: bigint;
        fullstack: bigint;
        data: bigint;
        devops: bigint;
        design: bigint;
      }>
    >`
      SELECT j."companyId" AS "companyId",
             count(*) FILTER (WHERE status = 'ACTIVE') AS active,
             count(*) FILTER (WHERE COALESCE("postedAt", "firstSeenAt") > now() - interval '30 days') AS new30,
             count(*) FILTER (WHERE COALESCE("postedAt", "firstSeenAt") BETWEEN now() - interval '60 days' AND now() - interval '30 days') AS prev30,
             max("firstSeenAt") AS last_job,
             min("firstSeenAt") AS first_job,
             count(*) FILTER (WHERE status='ACTIVE' AND title ~* 'back.?end|node|java|python|golang|\\.net|api|server') AS backend,
             count(*) FILTER (WHERE status='ACTIVE' AND title ~* 'front.?end|react|angular|vue|\\bui\\b') AS frontend,
             count(*) FILTER (WHERE status='ACTIVE' AND title ~* 'full.?stack|mern|mean') AS fullstack,
             count(*) FILTER (WHERE status='ACTIVE' AND title ~* 'data|\\bml\\b|machine learning|\\bai\\b|analyst|scientist') AS data,
             count(*) FILTER (WHERE status='ACTIVE' AND title ~* 'devops|\\bsre\\b|infra|platform|cloud') AS devops,
             count(*) FILTER (WHERE status='ACTIVE' AND title ~* 'design|\\bux\\b|\\bui\\b') AS design
      FROM jobs j
      GROUP BY j."companyId"
      HAVING count(*) FILTER (WHERE status = 'ACTIVE') > 0
      LIMIT ${Math.max(1, limit)}
    `;

    // Referral density: how many referral contacts we hold per company name.
    const refRows = await this.prisma.$queryRaw<Array<{ companyName: string; n: bigint }>>`
      SELECT "companyName", count(*) AS n FROM referral_contacts GROUP BY "companyName"
    `;
    const refByName = new Map(refRows.map((r) => [r.companyName.toLowerCase(), Number(r.n)]));

    // Company names (for the referral join) fetched once for this batch.
    const ids = rows.map((r) => r.companyId);
    const names = await this.prisma.company.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const nameById = new Map(names.map((c) => [c.id, c.name]));

    const now = Date.now();
    let done = 0;
    for (const r of rows) {
      const activeJobs = Number(r.active);
      const new30 = Number(r.new30);
      const prev30 = Number(r.prev30);
      const enoughHistory =
        !!r.first_job && now - new Date(r.first_job).getTime() > 45 * 86_400_000;
      const trend: Trend = trendFrom(new30, prev30, enoughHistory);
      const daysSinceLastJob = r.last_job
        ? Math.floor((now - new Date(r.last_job).getTime()) / 86_400_000)
        : null;
      const growthScore = companyGrowthScore({ activeJobs, newRoles30d: new30, trend, daysSinceLastJob });

      const departmentsHiring = {
        backend: Number(r.backend),
        frontend: Number(r.frontend),
        fullstack: Number(r.fullstack),
        data: Number(r.data),
        devops: Number(r.devops),
        design: Number(r.design),
      };
      const referralContacts = refByName.get((nameById.get(r.companyId) ?? '').toLowerCase()) ?? 0;

      const fields = {
        activeJobs,
        hiringTrend: trend as HiringTrend,
        growthScore,
        newRoles30d: new30,
        referralContacts,
        departmentsHiring: departmentsHiring as Prisma.InputJsonValue,
        lastJobAt: r.last_job,
        signalsAt: new Date(),
      };
      await this.prisma.companyIntelligence.upsert({
        where: { companyId: r.companyId },
        create: { companyId: r.companyId, ...fields },
        update: fields,
      });
      done++;
    }
    this.logger.log(`deriveSignalsCorpus: refreshed ${done} companies (deterministic)`);
    return { companies: done };
  }

  /** Companies with the most hiring momentum right now — the dashboard's mover list. */
  async topGrowing(limit = 12) {
    const rows = await this.prisma.companyIntelligence.findMany({
      where: { growthScore: { not: null }, activeJobs: { gt: 0 } },
      orderBy: [{ growthScore: 'desc' }, { newRoles30d: 'desc' }],
      take: Math.min(50, limit),
      select: {
        growthScore: true,
        newRoles30d: true,
        activeJobs: true,
        hiringTrend: true,
        referralContacts: true,
        company: { select: { name: true, city: true } },
      },
    });
    return rows.map((r) => ({
      company: r.company.name,
      city: r.company.city,
      growthScore: r.growthScore,
      newRoles30d: r.newRoles30d,
      activeJobs: r.activeJobs,
      hiringTrend: r.hiringTrend,
      referralContacts: r.referralContacts,
    }));
  }

  async get(companyId: string) {
    const intel = await this.prisma.companyIntelligence.findUnique({
      where: { companyId },
      include: {
        company: {
          select: {
            name: true,
            website: true,
            githubOrg: true,
            engineeringBlogUrl: true,
            industry: true,
            city: true,
            country: true,
            teamSize: true,
            confidence: true,
          },
        },
      },
    });
    if (!intel) throw new NotFoundException('No intelligence derived for this company yet');
    return intel;
  }

  /**
   * Hiring velocity from OUR observation history. firstSeenAt on a company's
   * initial import reflects when WE arrived, not when jobs were posted — so
   * the first observed day is excluded and young companies report
   * INSUFFICIENT_DATA instead of a fake spike.
   */
  private async hiringVelocity(companyId: string): Promise<{
    months: { month: string; newJobs: number }[];
    trend: HiringTrend;
  }> {
    const first = await this.prisma.crawlRun.findFirst({
      where: { companyId, status: 'SUCCEEDED' },
      orderBy: { startedAt: 'asc' },
      select: { startedAt: true },
    });
    if (!first || Date.now() - first.startedAt.getTime() < MIN_HISTORY_DAYS * 86_400_000) {
      return { months: [], trend: HiringTrend.INSUFFICIENT_DATA };
    }

    const cutoff = new Date(first.startedAt.getTime() + 86_400_000); // skip import burst
    const rows = await this.prisma.$queryRaw<{ month: string; new_jobs: bigint }[]>`
      SELECT to_char(date_trunc('month', "firstSeenAt"), 'YYYY-MM') AS month,
             count(*) AS new_jobs
      FROM jobs
      WHERE "companyId" = ${companyId} AND "firstSeenAt" > ${cutoff}
      GROUP BY 1 ORDER BY 1 DESC LIMIT 4
    `;
    const months = rows
      .map((r) => ({ month: r.month, newJobs: Number(r.new_jobs) }))
      .reverse();

    if (months.length < 2) return { months, trend: HiringTrend.INSUFFICIENT_DATA };
    const latest = months[months.length - 1].newJobs;
    const prevAvg =
      months.slice(0, -1).reduce((s, m) => s + m.newJobs, 0) / (months.length - 1);
    const trend =
      prevAvg === 0
        ? HiringTrend.INSUFFICIENT_DATA
        : latest > prevAvg * 1.25
          ? HiringTrend.GROWING
          : latest < prevAvg * 0.75
            ? HiringTrend.DECLINING
            : HiringTrend.STABLE;
    return { months, trend };
  }
}
