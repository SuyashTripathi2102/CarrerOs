import { TelegramSendError, type TelegramFailure } from './channels';
import { DailyBriefService, istDay } from './daily-brief.service';

const LOCAL = 'http://localhost:3000';
const PUBLIC = 'https://careeros.example.com';

function build(opts: { dashboard?: string; sendThrows?: boolean } = {}) {
  const calls = { sends: [] as { buttons?: unknown[][] }[], marked: 0 };
  const prisma = {
    user: { findMany: () => Promise.resolve([{ id: 'user-1' }]) },
    $queryRaw: () =>
      Promise.resolve([
        {
          matchId: 'match-1',
          score: 66,
          title: 'Backend Engineer',
          company: 'Acme',
          jobId: 'job-1',
        },
      ]),
    jobMatch: {
      updateMany: () => {
        calls.marked++;
        return Promise.resolve({ count: 1 });
      },
    },
  };
  const telegram = {
    isConfigured: () => true,
    send: (_text: string, sendOpts: { buttons?: unknown[][] }) => {
      if (opts.sendThrows)
        return Promise.reject(
          new Error('Telegram sendMessage -> 400: rejected'),
        );
      calls.sends.push(sendOpts);
      return Promise.resolve();
    },
  };
  const config = {
    get: (key: string) =>
      ({ CORS_ORIGIN: LOCAL, DASHBOARD_URL: opts.dashboard })[key],
  };
  const service = new DailyBriefService(
    prisma as never,
    telegram as never,
    config as never,
  );
  return { service, calls };
}

describe('CONSIDER digest', () => {
  it('sends with no dashboard button for a localhost dashboard', async () => {
    const { service, calls } = build({ dashboard: LOCAL });

    await expect(service.sendConsiderDigest()).resolves.toEqual({ sent: 1 });

    expect(calls.sends[0].buttons).toBeUndefined();
  });

  it('sends with no dashboard button when none is configured, regardless of CORS_ORIGIN', async () => {
    const { service, calls } = build();

    await service.sendConsiderDigest();

    expect(calls.sends[0].buttons).toBeUndefined();
  });

  it('links to a public dashboard', async () => {
    const { service, calls } = build({ dashboard: PUBLIC });

    await service.sendConsiderDigest();

    expect(calls.sends[0].buttons).toEqual([
      [{ text: '📊 Open Mission Control', url: PUBLIC }],
    ]);
  });

  it('marks jobs notified after a successful send', async () => {
    const { service, calls } = build();

    await service.sendConsiderDigest();

    expect(calls.marked).toBe(1);
  });

  it('marks nothing when the send fails, so tomorrow retries them', async () => {
    const { service, calls } = build({ sendThrows: true });

    await expect(service.sendConsiderDigest()).rejects.toThrow('rejected');

    expect(calls.marked).toBe(0);
  });
});

describe('daily brief: a brief that certainly did not arrive is retried, and never repeated', () => {
  // 22 Nov 2026, 22:09 IST: the moment the laptop woke and the brief was lost on DNS.
  const atWake = new Date('2026-11-22T16:39:13Z');
  const twoMinLater = new Date('2026-11-22T16:41:13Z');
  const nextMorning = new Date('2026-11-23T02:30:00Z'); // 08:00 IST, 23 Nov

  function briefService(sendResults: Array<'ok' | Error>) {
    const sends: string[] = [];
    const prisma = {
      user: { findMany: () => Promise.resolve([{ id: 'user-1', name: 'U' }]) },
    };
    const telegram = {
      isConfigured: () => true,
      send: (text: string) => {
        const next = sendResults.shift() ?? 'ok';
        if (next === 'ok') {
          sends.push(text);
          return Promise.resolve();
        }
        return Promise.reject(next);
      },
    };
    const config = { get: () => undefined };
    const service = new DailyBriefService(
      prisma as never,
      telegram as never,
      config as never,
    );
    const compose = jest
      .spyOn(
        service as unknown as { compose: () => Promise<string> },
        'compose',
      )
      .mockResolvedValue('the brief');
    return { service, sends, compose };
  }

  it('fails the job on a DNS failure at wake, so it is retried, and the retry delivers it once', async () => {
    const { service, sends } = briefService([
      new TelegramSendError('not-sent', 'Telegram not reached: EAI_AGAIN'),
    ]);
    await expect(service.sendAll(atWake)).rejects.toThrow(
      /not delivered to 1 user\(s\).*retry/,
    );
    expect(sends).toHaveLength(0);
    await expect(service.sendAll(twoMinLater)).resolves.toEqual({
      sent: 1,
      skipped: 0,
    });
    expect(sends).toEqual(['the brief']);
  });

  it.each(['rate-limited', 'server'] as const)(
    'retries a %s failure (Telegram did not take the message)',
    async (failure) => {
      const { service } = briefService([
        new TelegramSendError(failure, failure),
      ]);
      await expect(service.sendAll(atWake)).rejects.toThrow(/retry/);
    },
  );

  it.each(['ambiguous', 'config', 'rejected'] as const)(
    'does not retry a %s failure (it may have arrived, or would only fail again)',
    async (failure: TelegramFailure) => {
      const { service, sends } = briefService([
        new TelegramSendError(failure, failure),
      ]);
      await expect(service.sendAll(atWake)).resolves.toEqual({
        sent: 0,
        skipped: 0,
      });
      expect(sends).toHaveLength(0);
    },
  );

  it('does not retry an unclassified channel error (treated as possibly delivered)', async () => {
    const { service } = briefService([
      new Error('Telegram sendMessage -> 400: rejected'),
    ]);
    await expect(service.sendAll(atWake)).resolves.toEqual({
      sent: 0,
      skipped: 0,
    });
  });

  it('retries a brief that could not be composed (nothing was sent)', async () => {
    const { service, sends, compose } = briefService([]);
    compose.mockRejectedValueOnce(new Error('database hiccup'));
    await expect(service.sendAll(atWake)).rejects.toThrow(/retry/);
    await expect(service.sendAll(twoMinLater)).resolves.toEqual({
      sent: 1,
      skipped: 0,
    });
    expect(sends).toHaveLength(1);
  });

  it('never sends the same IST day twice: a later run that day skips the user', async () => {
    const { service, sends } = briefService([]);
    await expect(service.sendAll(atWake)).resolves.toEqual({
      sent: 1,
      skipped: 0,
    });
    await expect(service.sendAll(twoMinLater)).resolves.toEqual({
      sent: 0,
      skipped: 1,
    });
    expect(sends).toHaveLength(1);
  });

  it('sends again on the next IST day', async () => {
    const { service, sends } = briefService([]);
    await service.sendAll(atWake);
    await expect(service.sendAll(nextMorning)).resolves.toEqual({
      sent: 1,
      skipped: 0,
    });
    expect(sends).toHaveLength(2);
  });
});

describe('istDay', () => {
  it('switches day at 00:00 IST, which is 18:30 UTC', () => {
    expect(istDay(new Date('2026-11-22T18:29:59Z'))).toBe('2026-11-22');
    expect(istDay(new Date('2026-11-22T18:30:00Z'))).toBe('2026-11-23');
  });
});
