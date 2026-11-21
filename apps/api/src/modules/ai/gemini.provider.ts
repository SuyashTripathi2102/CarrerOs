import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiCallKind } from '@prisma/client';
import { AiUsageService, type RequestCover } from './ai-usage.service';
import { fileInputTokens } from './file-tokens';
import { parseModelJson } from './json.util';
import { EmbeddingProvider, FilePart, GenerateOptions, LlmProvider } from './llm.provider';
import { failureReason, isTimeout, neverSent } from './request-outcome';
import { billedOutputTokens, estimatedInputTokens } from './token-usage';
import { AiSpendBlockedError } from './spend-policy';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
// API allows 100/call, but the free tier's tokens-per-minute cap makes big
// batches 429 — smaller batches with pacing finish faster than retry loops.
// Free-tier embedding quota counts each batch ITEM as a request (~100/min):
// 20 items per call, one call every ~15s ≈ 80 items/min — safely under the cap.
const EMBED_BATCH_SIZE = 20;
const EMBED_BATCH_DELAY_MS = 15_000;
const MAX_RETRIES = 4;

/** Thrown without an HTTP call while the quota circuit is open. */
export class QuotaExhaustedError extends Error {
  constructor(retryAfterMs: number) {
    super(`Gemini quota circuit open — retrying after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'QuotaExhaustedError';
  }
}

@Injectable()
export class GeminiProvider implements LlmProvider, EmbeddingProvider {
  private readonly logger = new Logger(GeminiProvider.name);
  private readonly key: string;
  private readonly textModel: string;
  readonly embeddingModelId: string;
  private readonly embeddingDims: number;
  private readonly quotaCooldownMs: number;
  /** No answer within this long and the attempt is abandoned, and charged (see request()). */
  private readonly requestTimeoutMs: number;

  // Circuit breaker: when the daily quota is exhausted, every call 429s until
  // Google's midnight-Pacific reset. Without this, queued jobs hammer the API
  // in retry loops for hours (2026-07-07 incident: 8h of continuous 429s).
  private circuitOpenUntil = 0;

  constructor(
    config: ConfigService,
    private readonly usage: AiUsageService,
  ) {
    this.key = config.getOrThrow<string>('GEMINI_API_KEY');
    this.textModel = config.get<string>('GEMINI_TEXT_MODEL', 'gemini-3.5-flash');
    this.embeddingModelId = config.get<string>('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-2');
    this.embeddingDims = Number(config.get('EMBEDDING_DIMS', 1536));
    this.quotaCooldownMs = Number(config.get('AI_QUOTA_COOLDOWN_MS', 10 * 60_000));
    // 5 minutes: what Node's fetch already allowed for headers and for the body, now one bound for
    // the whole attempt.
    this.requestTimeoutMs =
      Number(config.get('AI_REQUEST_TIMEOUT_MS')) || 300_000;
  }

  async generateText(prompt: string, opts?: GenerateOptions): Promise<string> {
    return this.generate(prompt, opts, false);
  }

  async generateJson<T>(prompt: string, opts?: GenerateOptions): Promise<T> {
    const text = await this.generate(prompt, opts, true);
    return parseModelJson<T>(text);
  }

  async embed(
    texts: string[],
    opts?: { interactive?: boolean },
  ): Promise<number[][]> {
    const startedAt = Date.now();
    const out: number[][] = [];
    // Each request is admitted on its own (this loop may send many, minutes apart), and its
    // reservation is held until the call's cost is recorded below, so requests already answered
    // count. An attempt whose answer was lost is charged by its cover; `sentChars` counts the
    // answered ones.
    const covers: RequestCover[] = [];
    let sentChars = 0;
    try {
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
        const chars = batch.reduce((n, t) => n + t.length, 0);
        const cover = await this.usage.cover(
          {
            kind: AiCallKind.EMBED,
            model: this.embeddingModelId,
            interactive: opts?.interactive === true,
            items: batch.length,
            inputTokens: Math.ceil(chars / 4),
            maxOutputTokens: 0,
          },
          'gemini',
        );
        covers.push(cover);
        const body = {
          requests: batch.map((text) => ({
            model: `models/${this.embeddingModelId}`,
            content: { parts: [{ text }] },
            outputDimensionality: this.embeddingDims,
          })),
        };
        const res = await this.request<{ embeddings: { values: number[] }[] }>(
          `${BASE}/models/${this.embeddingModelId}:batchEmbedContents`,
          body,
          cover,
        );
        out.push(...res.embeddings.map((e) => e.values));
        sentChars += chars;

        if (i + EMBED_BATCH_SIZE < texts.length) {
          if ((i / EMBED_BATCH_SIZE) % 10 === 9) {
            this.logger.log(`Embedding progress: ${out.length}/${texts.length}`);
          }
          await new Promise((r) => setTimeout(r, EMBED_BATCH_DELAY_MS));
        }
      }
      this.usage.record({
        kind: AiCallKind.EMBED,
        provider: 'gemini',
        model: this.embeddingModelId,
        items: texts.length,
        // batchEmbedContents returns no usage metadata — ~4 chars/token estimate
        inputTokens: Math.ceil(sentChars / 4),
        ok: true,
        latencyMs: Date.now() - startedAt,
      });
      return out;
    } catch (err) {
      // Refused before anything was sent: no row, nothing was billed. Otherwise the requests that
      // did go out are recorded with their tokens, so their cost still counts.
      if (!(err instanceof AiSpendBlockedError && sentChars === 0)) {
        this.usage.record({
          kind: AiCallKind.EMBED,
          provider: 'gemini',
          model: this.embeddingModelId,
          items: texts.length,
          ...(sentChars > 0 ? { inputTokens: Math.ceil(sentChars / 4) } : {}),
          ok: false,
          errorCode: errorCode(err),
          latencyMs: Date.now() - startedAt,
        });
      }
      throw err;
    } finally {
      for (const cover of covers) cover.end();
    }
  }

  private async generate(
    prompt: string,
    opts: GenerateOptions | undefined,
    json: boolean,
  ): Promise<string> {
    const parts: unknown[] = [
      ...(opts?.files ?? []).map((f: FilePart) => ({
        inline_data: { mime_type: f.mimeType, data: f.data.toString('base64') },
      })),
      { text: prompt },
    ];

    const body = {
      contents: [{ role: 'user', parts }],
      ...(opts?.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      generationConfig: {
        ...(json ? { responseMimeType: 'application/json' } : {}),
        temperature: opts?.temperature ?? 0.2,
        maxOutputTokens: opts?.maxOutputTokens ?? 8192,
      },
    };

    const fileTokens = await fileInputTokens(opts?.files);
    const cover = await this.usage.cover(
      {
        kind: AiCallKind.GENERATE,
        model: this.textModel,
        interactive: opts?.interactive === true,
        inputTokens: estimatedInputTokens(prompt, {
          system: opts?.system,
          fileTokens,
        }),
        maxOutputTokens: body.generationConfig.maxOutputTokens,
      },
      'gemini',
    );

    const startedAt = Date.now();
    let recorded = false;
    try {
      const res = await this.request<{
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
        };
      }>(`${BASE}/models/${this.textModel}:generateContent`, body, cover);

      const text =
        res.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought)
          .map((p) => p.text ?? '')
          .join('') ?? '';

      // A 200 is billed whatever it contains, an empty answer included: record Google's counts, or
      // the worst case when it gave none.
      this.usage.record({
        kind: AiCallKind.GENERATE,
        provider: 'gemini',
        model: this.textModel,
        items: 1,
        inputTokens:
          res.usageMetadata?.promptTokenCount ?? cover.worstCase.inputTokens,
        outputTokens:
          billedOutputTokens(res.usageMetadata) ??
          cover.worstCase.maxOutputTokens,
        ok: text !== '',
        ...(text ? {} : { errorCode: 'empty_response' }),
        latencyMs: Date.now() - startedAt,
      });
      recorded = true;
      if (!text) throw new Error('Gemini returned an empty response');
      return text;
    } catch (err) {
      if (!recorded) {
        this.usage.record({
          kind: AiCallKind.GENERATE,
          provider: 'gemini',
          model: this.textModel,
          items: 1,
          ok: false,
          errorCode: errorCode(err),
          latencyMs: Date.now() - startedAt,
        });
      }
      throw err;
    } finally {
      cover.end();
    }
  }

  /**
   * POST with retry on 429/5xx — free-tier rate limits are expected, not fatal.
   *
   * Every attempt, retries included, is covered by `cover`: checked before it is sent, and charged
   * at its worst case when it ends with no confirmed outcome (see request-outcome.ts): no answer
   * (reset, timeout), a 5xx, or a 200 whose body cannot be read. A 4xx, or a connection that was
   * never made, is not charged: Google never processed the request.
   */
  private async request<T>(
    url: string,
    body: unknown,
    cover: RequestCover,
  ): Promise<T> {
    const wait = this.circuitOpenUntil - Date.now();
    if (wait > 0) throw new QuotaExhaustedError(wait);

    for (let attempt = 1; ; attempt++) {
      await cover.beforeAttempt();
      let res: Response;
      try {
        res = await fetch(`${url}?key=${this.key}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (err) {
        if (!neverSent(err)) cover.unconfirmed(failureReason(err));
        throw err;
      }

      if (res.ok) {
        this.circuitOpenUntil = 0;
        try {
          return (await res.json()) as T;
        } catch (err) {
          cover.unconfirmed('unreadable_200');
          throw err;
        }
      }

      if (res.status >= 500) cover.unconfirmed(`http_${res.status}`);
      const retryable = res.status === 429 || res.status >= 500;
      const text = await res.text().catch(() => '');
      if (!retryable || attempt >= MAX_RETRIES) {
        // Retries exhausted on 429 = quota is gone, not a blip. Open the
        // circuit so queued work fails fast instead of hammering for hours;
        // BullMQ backoff re-tries after the cooldown.
        if (res.status === 429) {
          this.circuitOpenUntil = Date.now() + this.quotaCooldownMs;
          this.logger.error(
            `Gemini quota exhausted — circuit open for ${this.quotaCooldownMs / 60_000}min`,
          );
        }
        throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
      }
      const delayMs = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
      this.logger.warn(`Gemini ${res.status}, retry ${attempt}/${MAX_RETRIES} in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function errorCode(err: unknown): string {
  if (err instanceof AiSpendBlockedError) return 'spend_blocked';
  if (err instanceof QuotaExhaustedError) return 'quota_circuit_open';
  if (isTimeout(err)) return 'timeout';
  const msg = err instanceof Error ? err.message : String(err);
  const status = /Gemini (\d{3})/.exec(msg)?.[1];
  return status ? `http_${status}` : 'error';
}
