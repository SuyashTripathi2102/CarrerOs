import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  aggregateSignalOutcomes,
  recommendationQuality,
  type OppEventInput,
} from './signal-analysis';

const EVENT_TYPES = new Set(['SHOWN', 'CLICKED', 'DISMISSED', 'APPLIED']);

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a user action on a recommendation, snapshotting the Opportunity Score
   * and its breakdown AS THEY ARE NOW (the live JobMatch breakdown is mutable —
   * rescores overwrite it). Append-only; never updates. Best-effort: a logging
   * failure must never break the user action that triggered it.
   */
  async record(
    userId: string,
    jobId: string,
    type: string,
    surface?: string,
    rank?: number,
  ): Promise<{ ok: boolean }> {
    const t = type.toUpperCase();
    if (!EVENT_TYPES.has(t)) return { ok: false };
    try {
      // Snapshot the current decision for this (user, job) from the active match,
      // plus the job's provenance — the immutable "why" and "from where".
      const [match, job] = await Promise.all([
        this.prisma.jobMatch.findFirst({
          where: { userId, jobId, decidedAt: { not: null } },
          orderBy: { createdAt: 'desc' },
          select: {
            opportunityScore: true,
            verdict: true,
            scoreBreakdown: true,
            decisionVersion: true,
          },
        }),
        this.prisma.job.findUnique({ where: { id: jobId }, select: { source: true } }),
      ]);
      await this.prisma.opportunityEvent.create({
        data: {
          userId,
          jobId,
          type: t,
          surface: surface ?? null,
          rank: rank ?? null,
          opportunityScore: match?.opportunityScore ?? null,
          verdict: match?.verdict ?? null,
          jobSource: job?.source ?? null,
          breakdown: (match?.scoreBreakdown ?? undefined) as Prisma.InputJsonValue | undefined,
          decisionVersion: match?.decisionVersion ?? null,
        },
      });
      return { ok: true };
    } catch (err) {
      this.logger.warn(`opportunity-event record failed: ${err instanceof Error ? err.message : err}`);
      return { ok: false };
    }
  }

  /**
   * Batch-record SHOWN impressions for a rendered list — one round trip for the
   * whole page, snapshotting score/verdict/provenance/rank per job. Impressions
   * are the denominator of CTR and apply-rate, so they must be cheap to log.
   */
  async recordImpressions(
    userId: string,
    surface: string,
    items: { jobId: string; rank?: number }[],
  ): Promise<{ recorded: number }> {
    if (items.length === 0) return { recorded: 0 };
    try {
      const jobIds = items.map((i) => i.jobId);
      const [matches, jobs] = await Promise.all([
        this.prisma.jobMatch.findMany({
          where: { userId, jobId: { in: jobIds }, decidedAt: { not: null } },
          orderBy: { createdAt: 'desc' },
          select: { jobId: true, opportunityScore: true, verdict: true, decisionVersion: true },
        }),
        this.prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, source: true } }),
      ]);
      const matchByJob = new Map<string, (typeof matches)[number]>();
      for (const m of matches) if (!matchByJob.has(m.jobId)) matchByJob.set(m.jobId, m);
      const sourceByJob = new Map(jobs.map((j) => [j.id, j.source]));

      const res = await this.prisma.opportunityEvent.createMany({
        data: items.map((i) => {
          const m = matchByJob.get(i.jobId);
          return {
            userId,
            jobId: i.jobId,
            type: 'SHOWN',
            surface,
            rank: i.rank ?? null,
            opportunityScore: m?.opportunityScore ?? null,
            verdict: m?.verdict ?? null,
            jobSource: sourceByJob.get(i.jobId) ?? null,
            decisionVersion: m?.decisionVersion ?? null,
          };
        }),
      });
      return { recorded: res.count };
    } catch (err) {
      this.logger.warn(`impressions record failed: ${err instanceof Error ? err.message : err}`);
      return { recorded: 0 };
    }
  }

  /**
   * Which signals actually separate engagement from dismissal — the Validation
   * phase's headline question. Reads the outcome log for this user (optionally
   * windowed) and runs the pure aggregation.
   */
  async signalOutcomes(userId: string, days = 90) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.opportunityEvent.findMany({
      where: { userId, createdAt: { gte: since } },
      select: { type: true, opportunityScore: true, breakdown: true },
    });
    const events: OppEventInput[] = rows.map((r) => ({
      type: r.type,
      opportunityScore: r.opportunityScore,
      breakdown: (r.breakdown as OppEventInput['breakdown']) ?? null,
    }));
    return { window: `${days}d`, ...aggregateSignalOutcomes(events) };
  }

  /**
   * The Recommendation Quality dashboard: funnel rates (CTR, apply, dismiss),
   * score separation (applied vs dismissed), and the signal-lift table — the
   * product-level read on whether the recommendations are actually good.
   */
  async quality(userId: string, days = 90) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.opportunityEvent.findMany({
      where: { userId, createdAt: { gte: since } },
      select: { type: true, opportunityScore: true, breakdown: true },
    });
    const events: OppEventInput[] = rows.map((r) => ({
      type: r.type,
      opportunityScore: r.opportunityScore,
      breakdown: (r.breakdown as OppEventInput['breakdown']) ?? null,
    }));
    return {
      window: `${days}d`,
      quality: recommendationQuality(events),
      signals: aggregateSignalOutcomes(events).signals,
    };
  }
}
