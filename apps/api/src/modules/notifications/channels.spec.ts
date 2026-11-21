import {
  TelegramChannel,
  TelegramSendError,
  TELEGRAM_TIMEOUT_MS,
} from './channels';

const TOKEN = '12345:AAH-test-token';

function channel() {
  const config = {
    get: (k: string) =>
      ({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' })[k],
  };
  return new TelegramChannel(config as never);
}

const reply = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    }),
  );

const fetchFailure = (code: string) =>
  Object.assign(new TypeError('fetch failed'), { cause: { code } });

async function failureOf(send: Promise<void>): Promise<TelegramSendError> {
  try {
    await send;
  } catch (err) {
    if (err instanceof TelegramSendError) return err;
    throw err;
  }
  throw new Error('expected the send to fail');
}

let fetchMock: jest.SpyInstance;
beforeEach(() => {
  fetchMock = jest.spyOn(global, 'fetch');
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('TelegramChannel.send classifies every outcome', () => {
  it('resolves on 200', async () => {
    fetchMock.mockImplementation(() => reply(200, { ok: true, result: {} }));
    await expect(channel().send('hi')).resolves.toBeUndefined();
  });

  it.each([
    [
      400,
      {
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities",
      },
      'rejected',
    ],
    [
      400,
      {
        ok: false,
        error_code: 400,
        description: 'Bad Request: BUTTON_URL_INVALID',
      },
      'rejected',
    ],
    [413, 'Request Entity Too Large', 'rejected'],
    [
      401,
      { ok: false, error_code: 401, description: 'Unauthorized' },
      'config',
    ],
    [
      403,
      {
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was blocked by the user',
      },
      'config',
    ],
    [404, { ok: false, error_code: 404, description: 'Not Found' }, 'config'],
    [
      429,
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 35',
        parameters: { retry_after: 35 },
      },
      'rate-limited',
    ],
    [
      500,
      { ok: false, error_code: 500, description: 'Internal Server Error' },
      'server',
    ],
    [502, 'Bad Gateway', 'server'],
  ])('HTTP %i is %s', async (status, body, failure) => {
    fetchMock.mockImplementation(() => reply(status, body));
    const err = await failureOf(channel().send('hi'));
    expect(err.failure).toBe(failure);
    expect(err.status).toBe(status);
  });

  it('reads retry_after from a 429', async () => {
    fetchMock.mockImplementation(() =>
      reply(429, {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 35 },
      }),
    );
    expect((await failureOf(channel().send('hi'))).retryAfterSec).toBe(35);
  });

  it.each([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
  ])(
    'a connection that never opened (%s) is not-sent: the message cannot have arrived',
    async (code) => {
      fetchMock.mockImplementation(() => Promise.reject(fetchFailure(code)));
      expect((await failureOf(channel().send('hi'))).failure).toBe('not-sent');
    },
  );

  it('an AggregateError is not-sent only when every address failed to connect', async () => {
    const both = {
      errors: [{ code: 'ECONNREFUSED' }, { code: 'ENETUNREACH' }],
    };
    fetchMock.mockImplementation(() =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: both }),
      ),
    );
    expect((await failureOf(channel().send('hi'))).failure).toBe('not-sent');
  });

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'])(
    'a connection lost mid-request (%s) is ambiguous: the message may have arrived',
    async (code) => {
      fetchMock.mockImplementation(() => Promise.reject(fetchFailure(code)));
      expect((await failureOf(channel().send('hi'))).failure).toBe('ambiguous');
    },
  );

  it('a timeout is ambiguous', async () => {
    fetchMock.mockImplementation(() =>
      Promise.reject(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      ),
    );
    const err = await failureOf(channel().send('hi'));
    expect(err.failure).toBe('ambiguous');
    expect(err.message).toContain(`${TELEGRAM_TIMEOUT_MS} ms`);
  });
});

describe('TelegramChannel bounds and holds', () => {
  it('gives every request a timeout signal', async () => {
    fetchMock.mockImplementation(() => reply(200, { ok: true }));
    await channel().send('hi');
    await channel().answerCallback('cb-1', 'ok');
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Deliberately channel-wide: CareerOS sends to one chat, so a refusal of the
  // bot or of that chat (a 403 "blocked by the user" included) refuses every
  // later message too, and each further request would only be refused again.
  it.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden: bot was blocked by the user'],
    [403, 'Forbidden: bot was kicked from the group chat'],
    [404, 'Not Found'],
  ])(
    'after a %i (%s) holds every later send, without calling Telegram again',
    async (status, description) => {
      fetchMock.mockImplementation(() =>
        reply(status, { ok: false, error_code: status, description }),
      );
      const ch = channel();
      await failureOf(ch.send('first'));
      expect(ch.heldReason()).toContain('TELEGRAM_BOT_TOKEN');
      expect(ch.heldReason()).toContain('unblock the bot');

      const second = await failureOf(ch.send('second'));
      expect(second.failure).toBe('config');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('never puts the bot token in an error message', async () => {
    const replies = [
      () => reply(400, { ok: false, description: 'Bad Request' }),
      () => reply(401, { ok: false, description: 'Unauthorized' }),
      () => Promise.reject(fetchFailure('ECONNRESET')),
      () => Promise.reject(new DOMException('timeout', 'TimeoutError')),
    ];
    for (const next of replies) {
      fetchMock.mockImplementation(next);
      const err = await failureOf(channel().send('hi'));
      expect(err.message).not.toContain(TOKEN);
    }
  });
});
