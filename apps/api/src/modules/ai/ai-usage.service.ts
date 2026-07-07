import { Injectable, Logger } from '@nestjs/common';
import { AiCallKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * USD per 1M tokens. Estimates for cost visibility, not billing truth —
 * Google's invoice is authoritative. Unknown models record null cost.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  'gemini-embedding-2': { input: 0.2, output: 0 },
  'gemini-embedding-001': { input: 0.15, output: 0 }, // Vertex embedding model
};

export interface AiCallRecord {
  kind: AiCallKind;
  provider: string;
  model: string;
  /** Items processed (texts embedded, or 1 for a generate call). */
  items: number;
  inputTokens?: number;
  outputTokens?: number;
  ok: boolean;
  errorCode?: string;
  latencyMs: number;
}

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Fire-and-forget — usage accounting must never fail an AI call. */
  record(call: AiCallRecord): void {
    const price = PRICE_PER_MTOK[call.model];
    const costUsd =
      price && (call.inputTokens != null || call.outputTokens != null)
        ? ((call.inputTokens ?? 0) * price.input + (call.outputTokens ?? 0) * price.output) / 1e6
        : null;

    void this.prisma.aiUsage
      .create({
        data: {
          kind: call.kind,
          provider: call.provider,
          model: call.model,
          items: call.items,
          inputTokens: call.inputTokens,
          outputTokens: call.outputTokens,
          costUsd,
          ok: call.ok,
          errorCode: call.errorCode,
          latencyMs: call.latencyMs,
        },
      })
      .catch((err: unknown) =>
        this.logger.warn(`usage record failed: ${err instanceof Error ? err.message : err}`),
      );
  }

  /** Aggregates for the usage endpoint: today + this calendar month (UTC). */
  async stats() {
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [today, month] = await Promise.all([
      this.aggregateSince(dayStart),
      this.aggregateSince(monthStart),
    ]);
    return { today, month };
  }

  private async aggregateSince(since: Date) {
    const rows = await this.prisma.aiUsage.groupBy({
      by: ['kind', 'provider', 'model'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { items: true, inputTokens: true, outputTokens: true, costUsd: true },
      _avg: { latencyMs: true },
    });

    const byKind = rows.map((r) => ({
      kind: r.kind,
      provider: r.provider,
      model: r.model,
      calls: r._count._all,
      items: r._sum.items ?? 0,
      inputTokens: r._sum.inputTokens ?? 0,
      outputTokens: r._sum.outputTokens ?? 0,
      avgLatencyMs: Math.round(r._avg.latencyMs ?? 0),
      estCostUsd: r._sum.costUsd ? Number(r._sum.costUsd) : 0,
    }));

    const errorRows = await this.prisma.aiUsage.groupBy({
      by: ['errorCode'],
      where: { createdAt: { gte: since }, ok: false },
      _count: { _all: true },
    });
    const errorsByCode = Object.fromEntries(
      errorRows.map((r) => [r.errorCode ?? 'unknown', r._count._all]),
    );

    return {
      since: since.toISOString(),
      calls: byKind.reduce((n, r) => n + r.calls, 0),
      errors: errorRows.reduce((n, r) => n + r._count._all, 0),
      errorsByCode,
      estCostUsd: Number(byKind.reduce((n, r) => n + r.estCostUsd, 0).toFixed(4)),
      byKind,
    };
  }
}
