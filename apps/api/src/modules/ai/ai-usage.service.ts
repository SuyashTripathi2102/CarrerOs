import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AiCallKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AiSpendBlockedError,
  dailyBudget,
  readSpendConfig,
  spendBlockReason,
} from './spend-policy';

const SPEND_CACHE_MS = 60_000;

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * USD per 1M tokens. Estimates for cost visibility, not billing truth —
 * Google's invoice is authoritative. A model missing here is refused before
 * any request (see admit()): its cost could not be counted, so a model change
 * in .env would otherwise switch the daily budget off without a word.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  'gemini-embedding-2': { input: 0.2, output: 0 },
  'gemini-embedding-001': { input: 0.15, output: 0 }, // Vertex embedding model
};

/** A call let through by admit(): its worst-case cost is held until release(). */
export interface Admission {
  readonly usd: number;
  readonly regime: 'credit' | 'post-credit';
  /** What was admitted, so an unconfirmed attempt can be charged at exactly this worst case. */
  readonly request: AdmitRequest;
}

/** What a call is about to send, for its worst-case cost. */
export interface AdmitRequest {
  kind: AiCallKind;
  model: string;
  interactive?: boolean;
  /** Texts in this request (embeddings); 1 for a generate call. */
  items?: number;
  /** Estimated input tokens. */
  inputTokens: number;
  /** The most output tokens the request allows (maxOutputTokens); 0 for embeddings. */
  maxOutputTokens: number;
}

/**
 * Covers one outbound request, however many attempts it takes, with a reservation of its worst
 * case (AiUsageService.admit). The providers call it around every network attempt:
 * - beforeAttempt(), before each attempt, retries included: it re-checks the settings, and after an
 *   attempt that was charged as unconfirmed the request is admitted again, so a retry needs room
 *   in the budget for another worst case;
 * - unconfirmed(reason), when an attempt ended with no confirmed outcome and may have been billed:
 *   its worst case is recorded as spent (AiUsageService.chargeUnconfirmed);
 * - end(), once the call's real cost has been recorded: whatever is still reserved is released.
 */
export class RequestCover {
  private current: Admission | null;
  private attemptStartedAt = Date.now();
  /** The worst case of one attempt, as admitted. */
  readonly worstCase: AdmitRequest;

  constructor(
    private readonly usage: Pick<
      AiUsageService,
      'admit' | 'assertStillAllowed' | 'chargeUnconfirmed' | 'release'
    >,
    private readonly provider: string,
    first: Admission,
  ) {
    this.current = first;
    this.worstCase = first.request;
  }

  async beforeAttempt(): Promise<void> {
    if (this.current) this.usage.assertStillAllowed(this.current);
    else this.current = await this.usage.admit(this.worstCase);
    this.attemptStartedAt = Date.now();
  }

  unconfirmed(reason: string): void {
    if (!this.current) return;
    this.usage.chargeUnconfirmed(
      this.current,
      this.provider,
      reason,
      Date.now() - this.attemptStartedAt,
    );
    this.current = null;
  }

  end(): void {
    if (this.current) this.usage.release(this.current);
    this.current = null;
  }
}

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
export class AiUsageService implements OnModuleInit {
  private readonly logger = new Logger(AiUsageService.name);

  private today: {
    dayStart: number;
    spentUsd: number;
    fetchedAt: number;
  } | null = null;
  /** Worst-case cost of the calls admitted and not yet finished. */
  private inFlightUsd = 0;
  /** Admissions already released or charged, so neither can happen twice. */
  private readonly ended = new WeakSet<Admission>();
  /** Configuration problems already logged, so each is reported once, not on every call. */
  private readonly reported = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /** A spending setting that is missing or wrong is reported when the API starts, not discovered later. */
  onModuleInit(): void {
    this.reportConfigProblems();
  }

  /**
   * Why a call of this kind must not be made right now, or null (see spend-policy.ts). A check
   * before starting work: it reserves nothing. The calls themselves go through admit().
   */
  async blockReason(
    kind: AiCallKind,
    interactive = false,
  ): Promise<string | null> {
    this.reportConfigProblems();
    return spendBlockReason({
      kind,
      interactive,
      spentTodayUsd: await this.spentTodayCached(),
      pendingUsd: this.inFlightUsd,
      env: process.env,
      now: Date.now(),
    });
  }

  /**
   * Lets one outbound request through, or throws AiSpendBlockedError. Every provider calls this
   * before every request it sends, so the rule holds for every caller, automatic or manual.
   *
   * The request's worst-case cost is reserved until release(): its estimated input and its full
   * output allowance. It is let through only if what was spent today, plus what the calls already
   * in flight may still cost, plus this worst case fits under the limit. So requests running at
   * the same time in this process cannot together overshoot it. The check and the reservation run
   * with no await between them, so no other call can slip in.
   */
  async admit(req: AdmitRequest): Promise<Admission> {
    this.reportConfigProblems();
    const price = PRICE_PER_MTOK[req.model];
    if (!price) {
      throw new AiSpendBlockedError(
        `model "${req.model}" has no price in PRICE_PER_MTOK (ai-usage.service.ts), so its cost could not be counted against the daily budget; add it there before using it`,
      );
    }
    const spentTodayUsd = await this.spentTodayCached();
    const usd =
      (req.inputTokens * price.input + req.maxOutputTokens * price.output) /
      1e6;
    const now = Date.now();
    const reason = spendBlockReason({
      kind: req.kind,
      interactive: req.interactive === true,
      spentTodayUsd,
      pendingUsd: this.inFlightUsd,
      callUsd: usd,
      env: process.env,
      now,
    });
    if (reason) throw new AiSpendBlockedError(reason);
    this.inFlightUsd += usd;
    const { regime } = dailyBudget(process.env, now);
    return {
      usd,
      regime: regime === 'post-credit' ? 'post-credit' : 'credit',
      request: { ...req },
    };
  }

  /** Admits a request (admit()) and covers every attempt it takes with that reservation. */
  async cover(req: AdmitRequest, provider: string): Promise<RequestCover> {
    return new RequestCover(this, provider, await this.admit(req));
  }

  /**
   * Before each network attempt of an admitted request, including retries: a request admitted
   * while the credit lasted is never sent once it has ended, and a setting broken in the meantime
   * stops it too. The budget itself was settled by admit().
   */
  assertStillAllowed(admission: Admission): void {
    const { regime } = dailyBudget(process.env, Date.now());
    if (regime === 'misconfigured') {
      throw new AiSpendBlockedError(
        `AI calls refused: ${readSpendConfig(process.env).problems.join('; ')}`,
      );
    }
    if (regime !== admission.regime) {
      throw new AiSpendBlockedError(
        `the credit period ended (${process.env.AI_CREDIT_EXPIRES_AT?.trim()}) while this call was waiting; not sent`,
      );
    }
  }

  /** Ends an admitted request: its reservation is released; record() has added what it really cost. */
  release(admission: Admission): void {
    if (this.ended.has(admission)) return;
    this.ended.add(admission);
    this.inFlightUsd = Math.max(0, this.inFlightUsd - admission.usd);
  }

  /**
   * An attempt that ended with no confirmed outcome may still have been processed and billed: the
   * connection failed or timed out after the request could have reached Google, a 5xx came back
   * (documented as not billed, but reported otherwise), or a 200 arrived and could not be read.
   * Its worst case is recorded as spent, in a row of its own (errorCode "unconfirmed_<reason>"),
   * so the daily total includes it in this process and every other; the reservation becomes that
   * charge.
   */
  chargeUnconfirmed(
    admission: Admission,
    provider: string,
    reason: string,
    latencyMs = 0,
  ): void {
    if (this.ended.has(admission)) return;
    const { kind, model, items, inputTokens, maxOutputTokens } =
      admission.request;
    this.record({
      kind,
      provider,
      model,
      items: items ?? 1,
      inputTokens,
      outputTokens: maxOutputTokens,
      ok: false,
      errorCode: `unconfirmed_${reason}`,
      latencyMs,
    });
    this.release(admission);
  }

  private reportConfigProblems(): void {
    for (const problem of readSpendConfig(process.env).problems) {
      if (this.reported.has(problem)) continue;
      this.reported.add(problem);
      this.logger.error(`AI spending configuration: ${problem}`);
    }
  }

  /** Read from the database at most once a minute; record() keeps it current in between. */
  private async spentTodayCached(): Promise<number> {
    const now = Date.now();
    const dayStart = utcDayStart(now);
    if (
      !this.today ||
      this.today.dayStart !== dayStart ||
      now - this.today.fetchedAt > SPEND_CACHE_MS
    ) {
      this.today = {
        dayStart,
        spentUsd: await this.spentTodayUsd(),
        fetchedAt: now,
      };
    }
    return this.today.spentUsd;
  }

  /**
   * USD spent since midnight UTC. The budget guard's input.
   *
   * Estimated from token counts, not Google's invoice — good enough to stop a
   * runaway, not an accounting record. Every model in use is priced (admit()
   * refuses the others). A request refused by Google (4xx) or never sent adds
   * nothing; one that may have been billed without an answer is charged at its
   * worst case (chargeUnconfirmed).
   */
  async spentTodayUsd(): Promise<number> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const agg = await this.prisma.aiUsage.aggregate({
      _sum: { costUsd: true },
      where: { createdAt: { gte: since } },
    });
    return Number(agg._sum.costUsd ?? 0);
  }

  /** Fire-and-forget — usage accounting must never fail an AI call. */
  record(call: AiCallRecord): void {
    const price = PRICE_PER_MTOK[call.model];
    const costUsd =
      price && (call.inputTokens != null || call.outputTokens != null)
        ? ((call.inputTokens ?? 0) * price.input + (call.outputTokens ?? 0) * price.output) / 1e6
        : null;
    if (
      costUsd &&
      this.today &&
      this.today.dayStart === utcDayStart(Date.now())
    ) {
      this.today.spentUsd += costUsd;
    }

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
