import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AiCallKind } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { JobClassifierService } from '../matching/job-classifier.service';
import { MatchingService } from '../matching/matching.service';
import { AiUsageService } from './ai-usage.service';
import {
  AiSpendBlockedError,
  spendBlockReason,
  type SpendEnv,
} from './spend-policy';
import { VertexGeminiProvider } from './vertex-gemini.provider';

/**
 * One test per failure the W3 review found (F1, F3, F5, F6, F7, F8). Every test uses only what the
 * W3 code under review already had, so this file runs against it unchanged: there, each test is
 * expected to FAIL, which is the demonstration. Against the fixed code each one passes.
 */

const DURING_CREDIT = Date.parse('2026-11-12T06:00:00Z');
const AFTER_CREDIT = Date.parse('2026-12-01T06:00:00Z');
const ENV: SpendEnv = {
  AI_DAILY_BUDGET_USD: '1.5',
  AI_INTERACTIVE_RESERVE_USD: '0.25',
  AI_CREDIT_EXPIRES_AT: '2026-11-25',
  AI_DAILY_BUDGET_AFTER_CREDIT_USD: '0',
};
const KEYS = Object.keys(ENV) as (keyof SpendEnv)[];

const policy = (over: Partial<Parameters<typeof spendBlockReason>[0]> = {}) =>
  spendBlockReason({
    kind: AiCallKind.GENERATE,
    interactive: false,
    spentTodayUsd: 0,
    env: ENV,
    now: DURING_CREDIT,
    ...over,
  });
const without = (key: keyof SpendEnv): SpendEnv => {
  const env = { ...ENV };
  delete env[key];
  return env;
};

/** The real usage service over a fake table that says `spentUsd` was recorded today. */
function usageService(spentUsd: number) {
  const prisma = {
    aiUsage: {
      aggregate: () => Promise.resolve({ _sum: { costUsd: spentUsd } }),
      create: () => Promise.resolve({}),
    },
  };
  return new AiUsageService(prisma as never);
}

/** The real Vertex provider, its network replaced by `fetchImpl`. */
function vertex(usage: AiUsageService, settings: Record<string, string> = {}) {
  const values: Record<string, string> = {
    GOOGLE_CLOUD_PROJECT: 'project',
    ...settings,
  };
  const provider = new VertexGeminiProvider(
    { get: (k: string) => values[k] } as never,
    usage,
  );
  Object.assign(provider, {
    auth: { getAccessToken: () => Promise.resolve('token') },
  });
  return provider;
}

const answer = (outputTokens: number) =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        candidates: [
          { content: { parts: [{ text: '{"jobs":[],"scores":[]}' }] } },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: outputTokens,
        },
      }),
  });
const embedding = () =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({ predictions: [{ embeddings: { values: [0.1] } }] }),
  });

describe('W3 fix regressions', () => {
  const realFetch = global.fetch;
  const saved: Partial<Record<keyof SpendEnv, string>> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      process.env[k] = ENV[k];
    }
  });
  afterEach(() => {
    global.fetch = realFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  describe('F1: the real-money guarantee holds without relying on .env', () => {
    it('a missing credit end date refuses every call', () => {
      expect(policy({ env: without('AI_CREDIT_EXPIRES_AT') })).not.toBeNull();
    });

    it('an unreadable credit end date refuses every call, even after that date has passed', () => {
      expect(
        policy({
          env: { ...ENV, AI_CREDIT_EXPIRES_AT: '25-11-2026' },
          now: AFTER_CREDIT,
        }),
      ).not.toBeNull();
    });

    it('after the credit, a missing post-credit budget means 0, not $2 a day', () => {
      expect(
        policy({
          env: without('AI_DAILY_BUDGET_AFTER_CREDIT_USD'),
          now: AFTER_CREDIT,
        }),
      ).not.toBeNull();
    });

    it('after the credit, an invalid post-credit budget means 0', () => {
      const env = { ...ENV, AI_DAILY_BUDGET_AFTER_CREDIT_USD: 'two' };
      expect(policy({ env, now: AFTER_CREDIT })).not.toBeNull();
    });
  });

  describe('F3: embeddings respect the reserve and the ceiling', () => {
    it('background embeddings stop at the budget minus the reserve', () => {
      expect(
        policy({ kind: AiCallKind.EMBED, spentTodayUsd: 1.3 }),
      ).not.toBeNull();
    });

    it('after the credit, embeddings are limited by a positive post-credit budget too', () => {
      const env = { ...ENV, AI_DAILY_BUDGET_AFTER_CREDIT_USD: '3' };
      expect(
        policy({
          kind: AiCallKind.EMBED,
          spentTodayUsd: 50,
          env,
          now: AFTER_CREDIT,
        }),
      ).not.toBeNull();
    });

    it('a multi-request embedding is checked before every request, not once', async () => {
      // Room for one 4,000-character text ($0.00015) but not two.
      const usage = usageService(1.25 - 0.0002);
      const fetchMock = jest.fn(() => embedding());
      global.fetch = fetchMock as never;
      const text = 'x'.repeat(4000);

      await vertex(usage, { VERTEX_EMBED_BATCH_SIZE: '1' })
        .embed([text, text, text])
        .catch(() => undefined);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('F5: calls running at once cannot together overshoot', () => {
    it('five concurrent calls with room for two: two are sent, three refused, and the limit holds', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(DURING_CREDIT);
      // $1.10 spent; the background limit is $1.25, so $0.15 is left. Each call may cost up to
      // 8,192 output tokens at $9 per million = $0.074, so two fit and a third does not.
      const usage = usageService(1.1);
      let sent = 0;
      global.fetch = jest.fn(async () => {
        sent++;
        await new Promise((r) => setTimeout(r, 20));
        return answer(8000);
      }) as never;
      const provider = vertex(usage);

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => provider.generateText('hello')),
      );

      expect(sent).toBe(2);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
      // $1.244 is now spent. Another background call could cost $0.074 more and is refused; the
      // user's own call may use the reserve, so it still goes through.
      await expect(provider.generateText('hello')).rejects.toBeInstanceOf(
        AiSpendBlockedError,
      );
      await expect(
        provider.generateText('hello', { interactive: true }),
      ).resolves.toBeDefined();
      expect(sent).toBe(3);
    });
  });

  describe('F6: a refused request is answered with its reason, not a server error', () => {
    @Controller('draft')
    class DraftController {
      @Get()
      draft(): string {
        throw new AiSpendBlockedError(
          'daily AI budget reached ($1.50/$1.50, credit)',
        );
      }
    }
    let app: INestApplication<App>;
    beforeAll(async () => {
      const module = await Test.createTestingModule({
        controllers: [DraftController],
      }).compile();
      app = module.createNestApplication({ logger: false });
      await app.init();
    });
    afterAll(() => app.close());

    it('returns 503 with the reason', async () => {
      const res = await request(app.getHttpServer()).get('/draft');
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).toContain('daily AI budget reached');
    });
  });

  describe('F7: a refused batch stops the run', () => {
    const refusing = () => {
      let calls = 0;
      const llm = {
        generateJson: () => {
          calls++;
          return Promise.reject(
            new AiSpendBlockedError('daily AI budget reached'),
          );
        },
      };
      return { llm, calls: () => calls };
    };
    const jobs = Array.from({ length: 15 }, (_, i) => ({
      id: `job-${i}`,
      title: 'Engineer',
      description: 'd',
    }));

    it('classification stops at the first refusal instead of trying every batch', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { llm, calls } = refusing();

      const result = await new JobClassifierService(llm as never).classify(
        jobs,
      );

      expect(calls()).toBe(1);
      expect(result.failedIds).toHaveLength(15);
    }, 60_000); // the code before the fix sleeps 6 s between batches before it fails on the count

    it('scoring stops at the first refusal instead of trying every batch', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { llm, calls } = refusing();
      const unused = {} as never;
      const service = new MatchingService(
        unused,
        llm as never,
        unused,
        unused,
        unused,
        unused,
        unused,
        unused,
      );
      const resume = {
        resumeVersionId: 'v1',
        parsed: {
          summaryForMatching: 's',
          skills: [],
          totalYearsExperience: 2,
        },
      };

      const result = await (
        service as unknown as {
          scoreAndUpsert(
            u: string,
            r: unknown,
            j: typeof jobs,
          ): Promise<{ failedJobIds: string[] }>;
        }
      ).scoreAndUpsert('user-1', resume, jobs);

      expect(calls()).toBe(1);
      expect(result.failedJobIds).toHaveLength(15);
    }, 60_000); // the code before the fix sleeps 8 s between batches before it fails on the count
  });

  describe('F8: a model with no known price is never called', () => {
    it('refuses an unpriced text model before any request', async () => {
      const fetchMock = jest.fn(() => answer(10));
      global.fetch = fetchMock as never;

      await expect(
        vertex(usageService(0), {
          VERTEX_TEXT_MODEL: 'gemini-99-ultra',
        }).generateText('hello'),
      ).rejects.toBeInstanceOf(AiSpendBlockedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses an unpriced embedding model before any request', async () => {
      const fetchMock = jest.fn(() => embedding());
      global.fetch = fetchMock as never;

      await expect(
        vertex(usageService(0), {
          VERTEX_EMBEDDING_MODEL: 'text-embedding-99',
        }).embed(['hello']),
      ).rejects.toBeInstanceOf(AiSpendBlockedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
