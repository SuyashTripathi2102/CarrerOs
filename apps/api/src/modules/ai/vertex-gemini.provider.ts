import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiCallKind } from '@prisma/client';
import { GoogleAuth } from 'google-auth-library';
import { AiUsageService, type RequestCover } from './ai-usage.service';
import { fileInputTokens } from './file-tokens';
import { parseModelJson } from './json.util';
import { EmbeddingProvider, FilePart, GenerateOptions, LlmProvider } from './llm.provider';
import { failureReason, isTimeout, neverSent } from './request-outcome';
import { billedOutputTokens, estimatedInputTokens } from './token-usage';
import { QuotaExhaustedError } from './gemini.provider';
import { AiSpendBlockedError } from './spend-policy';

// Vertex bills to Google Cloud (trial credits apply), unlike the Developer
// API (generativelanguage.googleapis.com) whose paid tier is prepaid-only.
// Same models, same token prices, different endpoint + auth.
const MAX_RETRIES = 4;

@Injectable()
export class VertexGeminiProvider implements LlmProvider, EmbeddingProvider {
  private readonly logger = new Logger(VertexGeminiProvider.name);
  private readonly auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  private readonly project: string;
  private readonly location: string;
  private readonly textModel: string;
  readonly embeddingModelId: string;
  private readonly embeddingDims: number;
  private readonly embedBatchSize: number;
  private readonly quotaCooldownMs: number;
  /** No answer within this long and the attempt is abandoned, and charged (see request()). */
  private readonly requestTimeoutMs: number;

  private circuitOpenUntil = 0;

  constructor(
    config: ConfigService,
    private readonly usage: AiUsageService,
  ) {
    // getOrThrow would break boot when vertex isn't selected — the module
    // factory instantiates this class eagerly, so validate lazily instead.
    // `||` fall-throughs (not config defaults): compose ${VAR:-} yields empty
    // strings, which ConfigService returns instead of the default.
    this.project = config.get<string>('GOOGLE_CLOUD_PROJECT') || '';
    this.location = config.get<string>('GOOGLE_CLOUD_LOCATION') || 'global';
    this.textModel =
      config.get<string>('VERTEX_TEXT_MODEL') ||
      config.get<string>('GEMINI_TEXT_MODEL') ||
      'gemini-3.5-flash';
    // NB: Vertex serves gemini-embedding-001, not the Developer API's -2 name
    this.embeddingModelId =
      config.get<string>('VERTEX_EMBEDDING_MODEL') || 'gemini-embedding-001';
    this.embeddingDims = Number(config.get('EMBEDDING_DIMS')) || 1536;
    // gemini-embedding models on Vertex historically cap instances-per-call
    // low; 1 is always safe, raise via env once the quota page confirms more.
    this.embedBatchSize = Number(config.get('VERTEX_EMBED_BATCH_SIZE')) || 1;
    this.quotaCooldownMs = Number(config.get('AI_QUOTA_COOLDOWN_MS', 10 * 60_000));
    // 5 minutes: what Node's fetch already allowed for headers and for the body, now one bound for
    // the whole attempt. The slowest successful call so far took 197 s (ai_usage, 9–12 Nov).
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
    // Each request is admitted on its own (this loop may send many), and its reservation is held
    // until the call's cost is recorded below, so the requests already answered always count. An
    // attempt whose answer was lost is charged by its cover; `sentChars` counts the answered ones.
    const covers: RequestCover[] = [];
    let sentChars = 0;
    try {
      for (let i = 0; i < texts.length; i += this.embedBatchSize) {
        const batch = texts.slice(i, i + this.embedBatchSize);
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
          'vertex',
        );
        covers.push(cover);
        const body = {
          instances: batch.map((text) => ({
            content: text,
            task_type: 'SEMANTIC_SIMILARITY',
          })),
          parameters: { outputDimensionality: this.embeddingDims },
        };
        const res = await this.request<{
          predictions: { embeddings: { values: number[] } }[];
        }>(this.modelUrl(this.embeddingModelId, 'predict'), body, cover);
        out.push(...res.predictions.map((p) => p.embeddings.values));
        sentChars += chars;
      }
      this.usage.record({
        kind: AiCallKind.EMBED,
        provider: 'vertex',
        model: this.embeddingModelId,
        items: texts.length,
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
          provider: 'vertex',
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
      'vertex',
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
      }>(this.modelUrl(this.textModel, 'generateContent'), body, cover);

      const text =
        res.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought)
          .map((p) => p.text ?? '')
          .join('') ?? '';

      // A 200 is billed whatever it contains, an empty answer included: record Google's counts, or
      // the worst case when it gave none.
      this.usage.record({
        kind: AiCallKind.GENERATE,
        provider: 'vertex',
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
      if (!text) throw new Error('Vertex returned an empty response');
      return text;
    } catch (err) {
      if (!recorded) {
        this.usage.record({
          kind: AiCallKind.GENERATE,
          provider: 'vertex',
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

  private modelUrl(model: string, verb: 'generateContent' | 'predict'): string {
    if (!this.project) {
      throw new Error(
        'GOOGLE_CLOUD_PROJECT is not set — required when an AI provider is "vertex"',
      );
    }
    const host =
      this.location === 'global'
        ? 'aiplatform.googleapis.com'
        : `${this.location}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${this.project}/locations/${this.location}/publishers/google/models/${model}:${verb}`;
  }

  /**
   * POST with SA-token auth + retry on 429/5xx + quota circuit (see GeminiProvider).
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

    const token = await this.auth.getAccessToken();

    for (let attempt = 1; ; attempt++) {
      await cover.beforeAttempt();
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
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
        if (res.status === 429) {
          this.circuitOpenUntil = Date.now() + this.quotaCooldownMs;
          this.logger.error(
            `Vertex quota exhausted — circuit open for ${this.quotaCooldownMs / 60_000}min`,
          );
        }
        throw new Error(`Vertex ${res.status}: ${text.slice(0, 300)}`);
      }
      const delayMs = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
      this.logger.warn(`Vertex ${res.status}, retry ${attempt}/${MAX_RETRIES} in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function errorCode(err: unknown): string {
  if (err instanceof AiSpendBlockedError) return 'spend_blocked';
  if (err instanceof QuotaExhaustedError) return 'quota_circuit_open';
  if (isTimeout(err)) return 'timeout';
  const msg = err instanceof Error ? err.message : String(err);
  const status = /Vertex (\d{3})/.exec(msg)?.[1];
  return status ? `http_${status}` : 'error';
}
