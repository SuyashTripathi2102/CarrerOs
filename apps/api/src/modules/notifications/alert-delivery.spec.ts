import {
  abandoned,
  afterSend,
  CONFIG_RETRY_DELAY_MS,
  DELIVERY_STATUSES,
  FIRST_RETRY_DELAY_MS,
  inAppOnly,
  isDue,
  isStale,
  MAX_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  parseDelivery,
  queued,
  retryDelayMs,
  STALE_SENDING_MS,
  startSending,
  withDelivery,
  type DeliveryState,
} from './alert-delivery';

const NOW = new Date('2026-11-12T12:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const sending = (attempts = 0): DeliveryState =>
  startSending({ ...queued(NOW), attempts }, NOW);

describe('afterSend: what each send outcome leaves on the record', () => {
  it('a confirmed send is SENT', () => {
    expect(afterSend(sending(), { ok: true }, NOW)).toMatchObject({
      status: 'SENT',
      attempts: 1,
    });
  });

  it('a refused message (400) is FAILED at once: it leaves the retry queue', () => {
    const next = afterSend(
      sending(),
      { ok: false, failure: 'rejected', error: 'Bad Request: x' },
      NOW,
    );
    expect(next).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'Bad Request: x',
    });
    expect(next.nextAttemptAt).toBeUndefined();
  });

  it('an ambiguous send (timeout, reset) is UNKNOWN: never re-sent automatically', () => {
    expect(
      afterSend(
        sending(),
        { ok: false, failure: 'ambiguous', error: 'timed out' },
        NOW,
      ),
    ).toMatchObject({
      status: 'UNKNOWN',
    });
  });

  it.each(['server', 'not-sent'] as const)(
    'a %s failure is RETRY after the backoff',
    (failure) => {
      const next = afterSend(
        sending(0),
        { ok: false, failure, error: 'x' },
        NOW,
      );
      expect(next).toMatchObject({
        status: 'RETRY',
        attempts: 1,
        nextAttemptAt: later(FIRST_RETRY_DELAY_MS),
      });
    },
  );

  it("a 429 waits for Telegram's retry_after", () => {
    const next = afterSend(
      sending(0),
      { ok: false, failure: 'rate-limited', error: 'x', retryAfterSec: 35 },
      NOW,
    );
    expect(next).toMatchObject({
      status: 'RETRY',
      nextAttemptAt: later(35_000),
    });
  });

  it('a configuration refusal waits an hour and does not use up an attempt', () => {
    const next = afterSend(
      sending(2),
      { ok: false, failure: 'config', error: '401' },
      NOW,
    );
    expect(next).toMatchObject({
      status: 'RETRY',
      attempts: 2,
      nextAttemptAt: later(CONFIG_RETRY_DELAY_MS),
    });
  });

  it(`gives up as FAILED after ${MAX_ATTEMPTS} counted attempts`, () => {
    const next = afterSend(
      sending(MAX_ATTEMPTS - 1),
      { ok: false, failure: 'server', error: '502' },
      NOW,
    );
    expect(next.status).toBe('FAILED');
    expect(next.lastError).toContain(`gave up after ${MAX_ATTEMPTS} attempts`);
  });

  it('keeps the version the send claimed, so only that send can write its outcome', () => {
    const claim = sending();
    expect(afterSend(claim, { ok: true }, NOW).version).toBe(claim.version);
  });
});

describe('retry schedule', () => {
  it('starts at 10 minutes, doubles, and stops growing at 6 hours', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual(
      [10, 20, 40, 80].map((m) => m * 60_000),
    );
    expect(retryDelayMs(20)).toBe(MAX_RETRY_DELAY_MS);
  });

  it('only QUEUED and due RETRY records may start a send', () => {
    expect(isDue(queued(NOW), NOW)).toBe(true);
    expect(
      isDue({ ...queued(NOW), status: 'RETRY', nextAttemptAt: later(-1) }, NOW),
    ).toBe(true);
    expect(
      isDue(
        { ...queued(NOW), status: 'RETRY', nextAttemptAt: later(60_000) },
        NOW,
      ),
    ).toBe(false);
    for (const status of ['SENDING', 'SENT', 'FAILED', 'UNKNOWN'] as const) {
      expect(isDue({ ...queued(NOW), status }, NOW)).toBe(false);
    }
  });
});

describe('interrupted sends', () => {
  it('a SENDING record older than the stale limit belongs to no live attempt', () => {
    const old = {
      ...sending(),
      updatedAt: new Date(NOW.getTime() - STALE_SENDING_MS - 1).toISOString(),
    };
    expect(isStale(old, NOW)).toBe(true);
    expect(isStale(sending(), NOW)).toBe(false);
  });

  it('resolves to UNKNOWN, with a new version, rather than back to a sendable state', () => {
    const claim = sending();
    const next = abandoned(claim, NOW);
    expect(next.status).toBe('UNKNOWN');
    expect(next.version).toBe(claim.version + 1);
  });
});

describe('reading records: fail closed', () => {
  const good = {
    status: 'RETRY',
    attempts: 1,
    version: 3,
    updatedAt: '2026-11-12T11:00:00.000Z',
    nextAttemptAt: '2026-11-12T11:10:00.000Z',
    lastError: 'Telegram sendMessage -> 502: Bad Gateway',
    channel: 'telegram',
  };
  const without = (key: keyof typeof good) => {
    const copy: Record<string, unknown> = { ...good };
    delete copy[key];
    return copy;
  };

  it('treats a row written before the record existed as SENT, so it is never re-sent', () => {
    const read = parseDelivery({ text: 'old alert', matchId: 'm1' });
    expect(read).toMatchObject({ ok: true, legacy: true });
    expect(read.ok && read.state.status).toBe('SENT');
  });

  it('round-trips a record and keeps the other payload keys', () => {
    const payload = withDelivery({ text: 'hi', matchId: 'm1' }, queued(NOW));
    expect(payload.text).toBe('hi');
    expect(parseDelivery(payload)).toEqual({
      ok: true,
      legacy: false,
      state: queued(NOW),
    });
  });

  it('reads a complete record', () => {
    expect(parseDelivery({ delivery: good })).toEqual({
      ok: true,
      legacy: false,
      state: good,
    });
  });

  it.each(DELIVERY_STATUSES)('accepts the status %s', (status) => {
    expect(parseDelivery({ delivery: { ...good, status } }).ok).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a null record', null],
    ['a text record', 'SENT'],
    ['a list record', [good]],
    ['a number record', 1],
    ['an unknown status', { ...good, status: 'DELIVERED' }],
    ['a lower-case status', { ...good, status: 'retry' }],
    ['a numeric status', { ...good, status: 1 }],
    ['no status', without('status')],
    ['no version', without('version')],
    ['a text version', { ...good, version: '3' }],
    ['version 0', { ...good, version: 0 }],
    ['a fractional version', { ...good, version: 1.5 }],
    ['an unsafe version', { ...good, version: 2 ** 53 }],
    ['no attempts', without('attempts')],
    ['negative attempts', { ...good, attempts: -1 }],
    ['no updatedAt', without('updatedAt')],
    ['an updatedAt that is not a time', { ...good, updatedAt: 'yesterday' }],
    ['a nextAttemptAt that is not a time', { ...good, nextAttemptAt: 'soon' }],
    ['a null nextAttemptAt', { ...good, nextAttemptAt: null }],
    [
      'a nextAttemptAt at 24:00',
      { ...good, nextAttemptAt: '2026-11-12T24:00:00.000Z' },
    ],
    [
      'a nextAttemptAt on 30 February',
      { ...good, nextAttemptAt: '2026-02-30T10:00:00.000Z' },
    ],
    [
      'a nextAttemptAt without milliseconds',
      { ...good, nextAttemptAt: '2026-11-12T11:10:00Z' },
    ],
    [
      'a nextAttemptAt in another zone',
      { ...good, nextAttemptAt: '2026-11-12T16:40:00.000+05:30' },
    ],
    ['a numeric lastError', { ...good, lastError: 502 }],
    ['an unknown channel', { ...good, channel: 'sms' }],
  ])('refuses %s, with the reason', (_case, delivery) => {
    const read = parseDelivery({ matchId: 'm1', delivery });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toEqual(expect.any(String));
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a list', []],
    ['text', 'payload'],
  ])('refuses a payload that is %s', (_case, payload) => {
    expect(parseDelivery(payload).ok).toBe(false);
  });
});

describe('in-app delivery', () => {
  it('is the next version of the record it replaces, so a compare-and-set sees the change', () => {
    const prev = { ...queued(NOW), version: 4 };
    expect(inAppOnly(prev, NOW)).toMatchObject({
      status: 'SENT',
      version: 5,
      channel: 'in-app',
    });
    expect(inAppOnly(null, NOW).version).toBe(1);
  });
});
