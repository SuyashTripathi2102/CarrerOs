import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  RequestCover,
  type Admission,
  type AdmitRequest,
  type AiCallRecord,
} from './ai-usage.service';
import { AiSpendBlockedError } from './spend-policy';
import { VertexGeminiProvider } from './vertex-gemini.provider';

/**
 * A refused request must never reach Google: no request means no bill. It must also leave no usage
 * row, or the refusal itself would count as spending. Every request is admitted on its own, and
 * re-checked before every attempt, retries included. An attempt Google may have billed without an
 * answer is charged; one it provably never processed is not.
 */
describe('provider spend guard', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  /** `allow`: how many requests are admitted before the next is refused. */
  function build(
    opts: {
      allow?: number;
      recheckFailsAt?: number;
      settings?: Record<string, string>;
    } = {},
  ) {
    const log = {
      admits: [] as AdmitRequest[],
      rechecks: 0,
      releases: 0,
      charges: [] as string[],
      records: [] as AiCallRecord[],
    };
    const usage = {
      admit: (request: AdmitRequest): Promise<Admission> => {
        log.admits.push(request);
        if (opts.allow !== undefined && log.admits.length > opts.allow) {
          return Promise.reject(
            new AiSpendBlockedError('daily AI budget reached'),
          );
        }
        return Promise.resolve({
          usd: 0.01,
          regime: 'credit' as const,
          request,
        });
      },
      assertStillAllowed: () => {
        log.rechecks++;
        if (
          opts.recheckFailsAt !== undefined &&
          log.rechecks >= opts.recheckFailsAt
        ) {
          throw new AiSpendBlockedError(
            'the credit period ended while this call was waiting; not sent',
          );
        }
      },
      release: () => {
        log.releases++;
      },
      chargeUnconfirmed: (
        _admission: Admission,
        _provider: string,
        reason: string,
      ) => {
        log.charges.push(reason);
      },
      record: (r: AiCallRecord) => {
        log.records.push(r);
      },
      cover: async (request: AdmitRequest, provider: string) =>
        new RequestCover(usage, provider, await usage.admit(request)),
    };
    const values: Record<string, string> = {
      GOOGLE_CLOUD_PROJECT: 'project',
      ...opts.settings,
    };
    const provider = new VertexGeminiProvider(
      { get: (k: string) => values[k] } as never,
      usage as never,
    );
    Object.assign(provider, {
      auth: { getAccessToken: () => Promise.resolve('token') },
    });
    return { provider, log };
  }

  const ok = (json: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(json) });
  const status = (code: number) =>
    Promise.resolve({
      ok: false,
      status: code,
      text: () => Promise.resolve('no'),
    });
  const answer = () =>
    ok({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4 },
    });
  const vector = () => ok({ predictions: [{ embeddings: { values: [0.1] } }] });

  it('refuses a generate call before any network request, and records nothing', async () => {
    const { provider, log } = build({ allow: 0 });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;

    await expect(provider.generateText('hello')).rejects.toBeInstanceOf(
      AiSpendBlockedError,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.records).toEqual([]);
  });

  it('refuses an embedding call before any network request, and records nothing', async () => {
    const { provider, log } = build({ allow: 0 });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;

    await expect(provider.embed(['hello'])).rejects.toBeInstanceOf(
      AiSpendBlockedError,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.records).toEqual([]);
  });

  it("asks with the caller's interactive flag and the request's worst case", async () => {
    const { provider, log } = build();
    global.fetch = jest.fn(() => answer()) as never;

    await provider.generateText('hello', {
      interactive: true,
      maxOutputTokens: 600,
    });
    await provider.generateText('hello');

    expect(log.admits).toEqual([
      expect.objectContaining({
        kind: 'GENERATE',
        interactive: true,
        maxOutputTokens: 600,
      }),
      expect.objectContaining({
        kind: 'GENERATE',
        interactive: false,
        maxOutputTokens: 8192,
      }),
    ]);
    expect(log.releases).toBe(2);
  });

  it('admits an embedding request by request, and stops at the first refusal', async () => {
    const { provider, log } = build({
      allow: 2,
      settings: { VERTEX_EMBED_BATCH_SIZE: '1' },
    });
    const fetchMock = jest.fn(() => vector());
    global.fetch = fetchMock as never;

    await expect(
      provider.embed(['aaaa', 'bbbb', 'cccc', 'dddd'], { interactive: true }),
    ).rejects.toBeInstanceOf(AiSpendBlockedError);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(log.admits).toHaveLength(3);
    expect(log.admits[0]).toEqual(
      expect.objectContaining({
        kind: 'EMBED',
        interactive: true,
        items: 1,
        inputTokens: 1,
        maxOutputTokens: 0,
      }),
    );
    // The two requests that went out are recorded, so their cost counts…
    expect(log.records).toEqual([
      expect.objectContaining({
        kind: 'EMBED',
        ok: false,
        errorCode: 'spend_blocked',
        inputTokens: 2,
      }),
    ]);
    // …and every reservation is released.
    expect(log.releases).toBe(2);
  });

  it('records a completed multi-request embedding once, with every token', async () => {
    const { provider, log } = build({
      settings: { VERTEX_EMBED_BATCH_SIZE: '1' },
    });
    global.fetch = jest.fn(() => vector()) as never;

    await provider.embed(['aaaa', 'bbbbbbbb']);

    expect(log.admits).toHaveLength(2);
    expect(log.records).toEqual([
      expect.objectContaining({ ok: true, items: 2, inputTokens: 3 }),
    ]);
    expect(log.releases).toBe(2);
  });

  it('re-checks before every attempt, retries included', async () => {
    jest.useFakeTimers();
    const { provider, log } = build();
    let attempt = 0;
    global.fetch = jest.fn(() =>
      ++attempt === 1 ? status(429) : answer(),
    ) as never;

    const call = provider.generateText('hello');
    await jest.advanceTimersByTimeAsync(5_000); // the first backoff
    await expect(call).resolves.toBe('hi');

    expect(attempt).toBe(2);
    expect(log.rechecks).toBe(2);
    expect(log.releases).toBe(1);
  });

  it('does not retry once the credit ended while it waited', async () => {
    jest.useFakeTimers();
    const { provider, log } = build({ recheckFailsAt: 2 });
    const fetchMock = jest.fn(() => status(429));
    global.fetch = fetchMock as never;

    const call = provider.generateText('hello');
    const settled = expect(call).rejects.toThrow('while this call was waiting');
    await jest.advanceTimersByTimeAsync(5_000);
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.releases).toBe(1);
  });

  it('releases the reservation when Google rejects the request (4xx), and charges nothing', async () => {
    const { provider, log } = build();
    global.fetch = jest.fn(() => status(400)) as never;

    await expect(provider.generateText('hello')).rejects.toThrow('Vertex 400');

    expect(log.charges).toEqual([]);
    expect(log.releases).toBe(1);
    expect(log.records).toEqual([
      expect.objectContaining({ ok: false, errorCode: 'http_400' }),
    ]);
  });

  it('does not charge a rate-limited attempt (429): it was never processed', async () => {
    jest.useFakeTimers();
    const { provider, log } = build();
    let attempt = 0;
    global.fetch = jest.fn(() =>
      ++attempt === 1 ? status(429) : answer(),
    ) as never;

    const call = provider.generateText('hello');
    await jest.advanceTimersByTimeAsync(5_000);
    await call;

    expect(log.charges).toEqual([]);
    expect(log.admits).toHaveLength(1);
  });

  it('charges a 5xx attempt at its worst case, and admits the retry again', async () => {
    jest.useFakeTimers();
    const { provider, log } = build();
    let attempt = 0;
    global.fetch = jest.fn(() =>
      ++attempt === 1 ? status(503) : answer(),
    ) as never;

    const call = provider.generateText('hello');
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(call).resolves.toBe('hi');

    expect(log.charges).toEqual(['http_503']);
    // The 503's reservation became its charge, so the retry needed a new admission…
    expect(log.admits).toHaveLength(2);
    // …which is released once the real cost is recorded.
    expect(log.records).toEqual([
      expect.objectContaining({ ok: true, inputTokens: 6, outputTokens: 4 }),
    ]);
    expect(log.releases).toBe(1);
  });

  it('sends no retry when the budget has no room for another worst case', async () => {
    jest.useFakeTimers();
    const { provider, log } = build({ allow: 1 });
    const fetchMock = jest.fn(() => status(503));
    global.fetch = fetchMock as never;

    const call = provider.generateText('hello');
    const settled = expect(call).rejects.toBeInstanceOf(AiSpendBlockedError);
    await jest.advanceTimersByTimeAsync(5_000);
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.charges).toEqual(['http_503']);
    expect(log.releases).toBe(0);
  });

  describe('over a real connection', () => {
    let server: Server;
    let base = '';
    let handler: (
      socketDestroy: () => void,
      respond: (code: number, body: string) => void,
    ) => void = () => undefined;
    beforeAll(async () => {
      server = createServer((req, res) => {
        req.resume();
        req.on('end', () =>
          handler(
            () => req.socket.destroy(),
            (code, body) =>
              res
                .writeHead(code, { 'content-type': 'application/json' })
                .end(body),
          ),
        );
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    /** Real fetch, sent to `url` instead of Google. */
    const via = (url: string) => {
      global.fetch = (_: unknown, init?: RequestInit) => realFetch(url, init);
    };

    it('does not charge a request that never left: the connection was refused', async () => {
      const closed = createServer();
      await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
      const port = (closed.address() as AddressInfo).port;
      await new Promise((r) => closed.close(r));
      const { provider, log } = build();
      via(`http://127.0.0.1:${port}/`);

      await expect(provider.generateText('hello')).rejects.toThrow(
        'fetch failed',
      );

      expect(log.charges).toEqual([]);
      expect(log.releases).toBe(1);
    });

    it('charges a request whose connection was closed after it was sent', async () => {
      const { provider, log } = build();
      handler = (destroy) => destroy();
      via(`${base}/`);

      await expect(provider.generateText('hello')).rejects.toThrow(
        'fetch failed',
      );

      expect(log.charges).toEqual(['network_UND_ERR_SOCKET']);
      expect(log.releases).toBe(0);
    });

    it('charges a request with no answer before the timeout', async () => {
      const { provider, log } = build({
        settings: { AI_REQUEST_TIMEOUT_MS: '200' },
      });
      handler = () => undefined;
      via(`${base}/`);

      await expect(provider.generateText('hello')).rejects.toThrow('timeout');

      expect(log.charges).toEqual(['timeout']);
      expect(log.records).toEqual([
        expect.objectContaining({ ok: false, errorCode: 'timeout' }),
      ]);
    });
  });
});
