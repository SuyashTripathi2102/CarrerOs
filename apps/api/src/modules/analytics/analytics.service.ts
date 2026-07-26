import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { aggregateSignalOutcomes, type OppEventInput } from './signal-analysis';

const EVENT_TYPES = new Set(['VIEWED', 'CLICKED', 'DISMISSED', 'APPLIED']);

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
  ): Promise<{ ok: boolean }> {
    const t = type.toUpperCase();
    if (!EVENT_TYPES.has(t)) return { ok: false };
    try {
      // Snapshot the current decision for this (user, job) from the active match.
      const match = await this.prisma.jobMatch.findFirst({
        where: { userId, jobId, decidedAt: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: {
          opportunityScore: true,
          verdict: true,
          scoreBreakdown: true,
          decisionVersion: true,
        },
      });
      await this.prisma.opportunityEvent.create({
        data: {
          userId,
          jobId,
          type: t,
          surface: surface ?? null,
          opportunityScore: match?.opportunityScore ?? null,
          verdict: match?.verdict ?? null,
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
}
