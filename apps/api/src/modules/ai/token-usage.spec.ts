import { RequestCover, type AdmitRequest } from './ai-usage.service';
import { billedOutputTokens, estimatedInputTokens } from './token-usage';
import { VertexGeminiProvider } from './vertex-gemini.provider';

describe('billedOutputTokens', () => {
  it('adds thinking tokens to the visible answer', () => {
    expect(
      billedOutputTokens({ candidatesTokenCount: 1, thoughtsTokenCount: 88 }),
    ).toBe(89);
  });

  it('works when the model did not think', () => {
    expect(billedOutputTokens({ candidatesTokenCount: 5 })).toBe(5);
  });

  it('counts thinking even with no visible answer', () => {
    expect(billedOutputTokens({ thoughtsTokenCount: 10 })).toBe(10);
  });

  it('reports nothing when the provider reported nothing', () => {
    expect(billedOutputTokens(undefined)).toBeUndefined();
    expect(billedOutputTokens({})).toBeUndefined();
  });
});

describe('estimatedInputTokens, for the worst case reserved before a request', () => {
  it('counts the prompt and the system instruction at 3 characters a token, rounding up', () => {
    expect(estimatedInputTokens('x'.repeat(10))).toBe(4);
    expect(estimatedInputTokens('x'.repeat(9), { system: 'y'.repeat(3) })).toBe(
      4,
    );
  });

  it('adds what the attached files may cost, as counted from the files (file-tokens.ts)', () => {
    expect(estimatedInputTokens('x'.repeat(9), { fileTokens: 2_240 })).toBe(
      3 + 2_240,
    );
  });

  it('estimates above what Google later counts for ordinary text (about 4 characters a token)', () => {
    const prompt = 'Score how well this candidate fits each job. '.repeat(40);
    expect(estimatedInputTokens(prompt)).toBeGreaterThan(
      Math.ceil(prompt.length / 4),
    );
  });
});

describe('VertexGeminiProvider usage recording', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('records thinking tokens as output, as Google bills them', async () => {
    const records: { outputTokens?: number; inputTokens?: number }[] = [];
    const config = {
      get: (key: string) => ({ GOOGLE_CLOUD_PROJECT: 'project' })[key],
    };
    const usage = {
      admit: (request: AdmitRequest) =>
        Promise.resolve({ usd: 0, regime: 'credit' as const, request }),
      assertStillAllowed: () => undefined,
      release: () => undefined,
      chargeUnconfirmed: () => undefined,
      record: (r: { outputTokens?: number }) => records.push(r),
      cover: async (request: AdmitRequest, provider: string) =>
        new RequestCover(usage, provider, await usage.admit(request)),
    };
    const provider = new VertexGeminiProvider(config as never, usage as never);
    Object.assign(provider, {
      auth: { getAccessToken: () => Promise.resolve('token') },
    });
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [{ content: { parts: [{ text: 'ok' }] } }],
            usageMetadata: {
              promptTokenCount: 6,
              candidatesTokenCount: 1,
              thoughtsTokenCount: 88,
            },
          }),
      }),
    ) as never;

    await provider.generateText('Reply with ok.');

    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(6);
    expect(records[0].outputTokens).toBe(89);
  });
});
