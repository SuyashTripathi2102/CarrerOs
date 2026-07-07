import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiCallKind } from '@prisma/client';
import { AiUsageService } from './ai-usage.service';
import { parseModelJson } from './json.util';
import { EmbeddingProvider, FilePart, GenerateOptions, LlmProvider } from './llm.provider';

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
  }

  async generateText(prompt: string, opts?: GenerateOptions): Promise<string> {
    return this.generate(prompt, opts, false);
  }

  async generateJson<T>(prompt: string, opts?: GenerateOptions): Promise<T> {
    const text = await this.generate(prompt, opts, true);
    return parseModelJson<T>(text);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const startedAt = Date.now();
    const out: number[][] = [];
    try {
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
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
        );
        out.push(...res.embeddings.map((e) => e.values));

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
        inputTokens: Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4),
        ok: true,
        latencyMs: Date.now() - startedAt,
      });
      return out;
    } catch (err) {
      this.usage.record({
        kind: AiCallKind.EMBED,
        provider: 'gemini',
        model: this.embeddingModelId,
        items: texts.length,
        ok: false,
        errorCode: errorCode(err),
        latencyMs: Date.now() - startedAt,
      });
      throw err;
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

    const startedAt = Date.now();
    try {
      const res = await this.request<{
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      }>(`${BASE}/models/${this.textModel}:generateContent`, body);

      const text =
        res.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought)
          .map((p) => p.text ?? '')
          .join('') ?? '';
      if (!text) throw new Error('Gemini returned an empty response');

      this.usage.record({
        kind: AiCallKind.GENERATE,
        provider: 'gemini',
        model: this.textModel,
        items: 1,
        inputTokens: res.usageMetadata?.promptTokenCount,
        outputTokens: res.usageMetadata?.candidatesTokenCount,
        ok: true,
        latencyMs: Date.now() - startedAt,
      });
      return text;
    } catch (err) {
      this.usage.record({
        kind: AiCallKind.GENERATE,
        provider: 'gemini',
        model: this.textModel,
        items: 1,
        ok: false,
        errorCode: errorCode(err),
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  /** POST with retry on 429/5xx — free-tier rate limits are expected, not fatal. */
  private async request<T>(url: string, body: unknown): Promise<T> {
    const wait = this.circuitOpenUntil - Date.now();
    if (wait > 0) throw new QuotaExhaustedError(wait);

    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${url}?key=${this.key}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        this.circuitOpenUntil = 0;
        return (await res.json()) as T;
      }

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
  if (err instanceof QuotaExhaustedError) return 'quota_circuit_open';
  const msg = err instanceof Error ? err.message : String(err);
  const status = /Gemini (\d{3})/.exec(msg)?.[1];
  return status ? `http_${status}` : 'error';
}
