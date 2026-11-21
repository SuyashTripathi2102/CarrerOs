import { Logger } from '@nestjs/common';
import { TelegramAppliedService } from './telegram-applied.service';
import { encodeAppliedToken } from './telegram-callback';
import {
  TelegramApiError,
  TelegramPollerService,
} from './telegram-poller.service';

const BOT_TOKEN = '12345:AAH-bot-token';
const CALLBACK_SECRET = `careeros-callback:${BOT_TOKEN}`;
const CHAT_ID = '987654321';
const NOTIF = 'cmtu225100df6f5j4uxbfl82l';

/** One scripted Telegram answer: a reply, a network error, or a long poll that waits until aborted. */
type Reply = { status?: number; body: unknown } | Error | 'hang';

interface Sent {
  method: string;
  body: { offset?: number; timeout?: number; allowed_updates?: string[] };
  signal?: AbortSignal;
}

interface Options {
  inbound?: string;
  webhookUrl?: string;
  /** getWebhookInfo answers, in order; then "no webhook". */
  webhookInfo?: Reply[];
  /** getUpdates answers, in order; then a long poll that waits until aborted. */
  updates?: Reply[];
}

function answer(
  reply: Reply,
  signal: AbortSignal | undefined,
): Promise<Response> {
  if (reply === 'hang') {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(
          Object.assign(new Error('This operation was aborted'), {
            name: 'AbortError',
          }),
        );
      });
    });
  }
  if (reply instanceof Error) return Promise.reject(reply);
  const status = reply.status ?? 200;
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(reply.body),
  } as unknown as Response);
}

function build(opts: Options = {}) {
  const calls = {
    created: [] as { userId: string; jobId: string }[],
    answered: [] as string[],
    sent: [] as Sent[],
  };
  const prisma = {
    notification: {
      findUnique: () =>
        Promise.resolve({ userId: 'user-1', payload: { jobId: 'job-1' } }),
    },
    application: { findUnique: () => Promise.resolve(null) },
  };
  const applications = {
    createFromJob: (userId: string, jobId: string) => {
      calls.created.push({ userId, jobId });
      return Promise.resolve({ id: 'app-1' });
    },
  };
  const telegram = {
    isConfigured: () => true,
    answerCallback: (_id: string, text: string) => {
      calls.answered.push(text);
      return Promise.resolve();
    },
  };
  const env: Record<string, string | undefined> = {
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_CHAT_ID: CHAT_ID,
    TELEGRAM_INBOUND: opts.inbound,
  };
  const config = { get: (k: string) => env[k] };
  const webhookInfo = [...(opts.webhookInfo ?? [])];
  const updates = [...(opts.updates ?? [])];
  // Its own parameter types: the poller passes a URL string and a JSON body, nothing else.
  const fakeFetch = (
    input: string | URL | { url: string },
    init?: { body?: unknown; signal?: AbortSignal | null },
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = url.split('/').pop() ?? '';
    const signal = init?.signal ?? undefined;
    const body = typeof init?.body === 'string' ? init.body : '{}';
    calls.sent.push({
      method,
      body: JSON.parse(body) as Sent['body'],
      signal,
    });
    if (method === 'getWebhookInfo') {
      return answer(
        webhookInfo.shift() ?? {
          body: { ok: true, result: { url: opts.webhookUrl ?? '' } },
        },
        signal,
      );
    }
    return answer(updates.shift() ?? 'hang', signal);
  };
  global.fetch = jest.fn(fakeFetch);

  const applied = new TelegramAppliedService(
    prisma as never,
    applications as never,
    telegram as never,
  );
  const poller = new TelegramPollerService(
    applied,
    telegram as never,
    config as never,
  );
  return { poller, calls, methods: () => calls.sent.map((s) => s.method) };
}

const tap = (
  updateId: number,
  fromId = CHAT_ID,
  data = encodeAppliedToken(NOTIF, CALLBACK_SECRET),
) => ({
  update_id: updateId,
  callback_query: { id: `cb-${updateId}`, data, from: { id: fromId } },
});
const ok = (result: unknown): Reply => ({ body: { ok: true, result } });
const refused = (status: number, description: string): Reply => ({
  status,
  body: { ok: false, description },
});

const realFetch = global.fetch;
let logged: { level: string; message: string }[];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((message: unknown) => {
        logged.push({ level, message: String(message) });
      });
  }
});
afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

describe('TelegramPollerService', () => {
  it('will not poll while a webhook is registered (it never deletes one)', async () => {
    const { poller, methods } = build({
      webhookUrl: 'https://example.org/api/telegram/webhook',
    });
    await expect(poller.canPoll()).resolves.toBe(false);
    expect(methods()).toEqual(['getWebhookInfo']);
  });

  it('records a signed tap from the configured chat and acknowledges it', async () => {
    const { poller, calls } = build({ updates: [ok([tap(41)])] });

    await expect(poller.pollOnce()).resolves.toBe(1);

    expect(calls.created).toEqual([{ userId: 'user-1', jobId: 'job-1' }]);
    expect(calls.answered[0]).toMatch(/Recorded as applied/i);
    expect(calls.sent[0].body).toMatchObject({
      allowed_updates: ['callback_query'],
    });
  });

  it('moves past each update, so the next round confirms it with Telegram', async () => {
    const { poller, calls } = build({
      updates: [ok([tap(41), tap(42)]), ok([])],
    });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(calls.sent[0].body.offset).toBeUndefined();
    expect(calls.sent[1].body.offset).toBe(43);
  });

  it('writes nothing for a stranger or an unsigned payload, and still moves past them', async () => {
    const { poller, calls } = build({
      updates: [
        ok([tap(7, '55555'), tap(8, CHAT_ID, `a:${NOTIF}:0000000000`)]),
        ok([]),
      ],
    });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(calls.created).toHaveLength(0);
    expect(calls.answered).toHaveLength(0);
    expect(calls.sent[1].body.offset).toBe(9);
  });

  it('surfaces a 409 conflict as TelegramApiError without the token in the message', async () => {
    const { poller } = build({
      updates: [
        refused(409, 'Conflict: terminated by other getUpdates request'),
      ],
    });

    const err = await poller.pollOnce().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).status).toBe(409);
    expect((err as Error).message).not.toContain(BOT_TOKEN);
  });

  it('does nothing at all unless TELEGRAM_INBOUND=polling', async () => {
    const { poller, calls } = build({ inbound: undefined });
    poller.onApplicationBootstrap();
    await poller.onModuleDestroy();
    expect(calls.sent).toHaveLength(0);
  });
});

describe('TelegramPollerService: the polling loop', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Lets the loop run until `check` holds, without moving the clock. */
  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 500; i++) {
      if (check()) return;
      await jest.advanceTimersByTimeAsync(0);
    }
    throw new Error('the loop never reached the expected point');
  }
  const waits = () =>
    logged
      .map((l) => /retrying in (\d+)s/.exec(l.message)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);
  const errors = () =>
    logged.filter((l) => l.level === 'error').map((l) => l.message);

  it('checks for a webhook first, then polls', async () => {
    const { poller, methods } = build({
      inbound: 'polling',
      updates: [ok([])],
    });

    poller.onApplicationBootstrap();
    await until(() => methods().length === 3);

    expect(methods()).toEqual(['getWebhookInfo', 'getUpdates', 'getUpdates']);
    await poller.onModuleDestroy();
  });

  it('does not poll at all while a webhook is registered, and says why', async () => {
    const { poller, methods } = build({
      inbound: 'polling',
      webhookUrl: 'https://example.org/api/telegram/webhook',
    });

    poller.onApplicationBootstrap();
    await until(() => errors().length === 1);
    await jest.advanceTimersByTimeAsync(10 * 60_000);

    expect(methods()).toEqual(['getWebhookInfo']);
    expect(errors()[0]).toMatch(/a Telegram webhook is registered/);
    await poller.onModuleDestroy();
  });

  it('after a 409 conflict, waits 30 s and checks for a webhook again before polling', async () => {
    const { poller, methods } = build({
      inbound: 'polling',
      updates: [
        refused(409, 'Conflict: terminated by other getUpdates request'),
      ],
    });

    poller.onApplicationBootstrap();
    await until(() => waits().length === 1);
    expect(waits()).toEqual([30]);
    await jest.advanceTimersByTimeAsync(29_000);
    expect(methods()).toEqual(['getWebhookInfo', 'getUpdates']);

    await jest.advanceTimersByTimeAsync(1_000);
    await until(() => methods().length === 4);

    expect(methods()).toEqual([
      'getWebhookInfo',
      'getUpdates',
      'getWebhookInfo',
      'getUpdates',
    ]);
    await poller.onModuleDestroy();
  });

  it('backs off 2 s, then 4 s, and returns to 2 s after a successful poll', async () => {
    const bad = refused(502, 'Bad Gateway');
    const { poller, methods } = build({
      inbound: 'polling',
      updates: [bad, bad, ok([]), bad],
    });

    poller.onApplicationBootstrap();
    await until(() => waits().length === 1);
    await jest.advanceTimersByTimeAsync(2_000);
    await until(() => waits().length === 2);
    await jest.advanceTimersByTimeAsync(4_000);
    await until(() => waits().length === 3);

    expect(waits()).toEqual([2, 4, 2]);
    expect(methods().filter((m) => m === 'getUpdates')).toHaveLength(4);
    await poller.onModuleDestroy();
  });

  it('shutdown aborts a long poll in progress and returns at once', async () => {
    const { poller, calls, methods } = build({ inbound: 'polling' });

    poller.onApplicationBootstrap();
    await until(() => methods().includes('getUpdates'));
    const inFlight = calls.sent[calls.sent.length - 1];

    await poller.onModuleDestroy();

    expect(inFlight.signal?.aborted).toBe(true);
    expect(methods()).toEqual(['getWebhookInfo', 'getUpdates']);
    expect(logged.some((l) => l.message.includes('polling failed'))).toBe(
      false,
    );
  });

  it('shutdown during a back-off returns at once and polls no more', async () => {
    const { poller, methods } = build({
      inbound: 'polling',
      updates: [refused(502, 'Bad Gateway')],
    });

    poller.onApplicationBootstrap();
    await until(() => waits().length === 1);

    await poller.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(10 * 60_000);

    expect(methods()).toEqual(['getWebhookInfo', 'getUpdates']);
  });

  it.each<[number, string]>([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'Not Found'],
  ])(
    'stops polling for good on %i (%s): one error line, no retries',
    async (status, description) => {
      const { poller, methods } = build({
        inbound: 'polling',
        updates: [refused(status, description)],
      });

      poller.onApplicationBootstrap();
      await until(() => errors().length === 1);
      await jest.advanceTimersByTimeAsync(10 * 60_000);

      expect(methods()).toEqual(['getWebhookInfo', 'getUpdates']);
      expect(errors()).toEqual([
        `Telegram refused the bot (getUpdates -> ${status}: ${description}); polling stopped. Check TELEGRAM_BOT_TOKEN, then restart the API.`,
      ]);
      expect(waits()).toEqual([]);
      expect(errors()[0]).not.toContain(BOT_TOKEN);
      await poller.onModuleDestroy();
    },
  );

  it('stops polling for good when the startup webhook check is refused (401)', async () => {
    const { poller, methods } = build({
      inbound: 'polling',
      webhookInfo: [refused(401, 'Unauthorized')],
    });

    poller.onApplicationBootstrap();
    await until(() => errors().length === 1);
    await jest.advanceTimersByTimeAsync(10 * 60_000);

    expect(methods()).toEqual(['getWebhookInfo']);
    expect(errors()[0]).toMatch(
      /getWebhookInfo -> 401: Unauthorized\); polling stopped/,
    );
    await poller.onModuleDestroy();
  });
});
