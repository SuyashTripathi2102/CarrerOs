import { Logger } from '@nestjs/common';
import { parseDelivery, queued } from './alert-delivery';
import { TelegramSendError, type TelegramFailure } from './channels';
import { NotificationsService } from './notifications.service';

/**
 * The property under test is the delivery contract: a match is marked notified
 * only once its alert reached the channel, an alert that may have arrived is
 * never sent again, and one that was refused for good leaves the retry queue.
 *
 * The fake database records writes, because "did this reach the database" is
 * the claim. It does not lock or run SQL: its retry query returns the newest row
 * of every alert, and the pass decides in code, as it does for real. The
 * advisory lock, the real query, the compare-and-set that moves a record back,
 * and real concurrency are covered against Postgres in
 * notifications-delivery.int.spec.ts.
 */

const LOCAL = 'http://localhost:3000';
const PUBLIC = 'https://careeros.example.com';

const baseMatch = (id = 'match-1') => ({
  id,
  jobId: `job-${id}`,
  opportunityScore: 90,
  overallScore: 80,
  missingSkills: [],
  scoreBreakdown: [],
  reasoning: 'A strong fit.',
  verdict: 'APPLY',
  verdictCode: 'TARGET_ROLE_ELIGIBLE',
  verdictReason: 'Strong match',
  notifiedAt: null,
  job: {
    id: `job-${id}`,
    title: 'Backend Engineer',
    url: 'https://jobs.example.com/1',
    externalId: 'ext-1',
    companyId: 'company-1',
    country: 'IN',
    location: 'Bengaluru',
    workMode: 'REMOTE',
    postedAt: new Date(),
    firstSeenAt: new Date(),
    salaryMin: null,
    salaryMax: null,
    currency: null,
    company: {
      name: 'Acme',
      atsProvider: 'GREENHOUSE',
      atsIdentifier: 'acme',
      careerPageUrl: null,
    },
  },
  user: { id: 'user-1', preference: { countries: [] } },
});

type Row = {
  id: string;
  userId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};
type Outcome = 'ok' | TelegramFailure;

function build(
  opts: {
    dashboard?: string;
    configured?: boolean;
    outcomes?: Outcome[];
    throwsFor?: string;
    updateFails?: boolean;
    held?: string;
    /** Runs while a send is in flight, after it was claimed. */
    onSend?: (rows: Row[]) => void;
    /** Runs once, just before the first compare-and-set write: another writer's change. */
    beforeFirstWrite?: (rows: Row[]) => void;
  } = {},
) {
  const calls = {
    sends: [] as { buttons?: unknown[][] }[],
    marked: [] as string[],
    rows: [] as Row[],
  };
  const outcomes = [...(opts.outcomes ?? [])];
  let seq = 0;

  // The fakes are async to keep Prisma's and the channel's promise API; most
  // have nothing to await.
  /* eslint-disable @typescript-eslint/require-await */
  const prisma: Record<string, unknown> = {
    $executeRaw: async () => 1,
    // The retry query: the newest row of every alert.
    $queryRaw: async () => {
      const newest = new Map<unknown, Row>();
      for (const r of calls.rows) {
        const seen = newest.get(r.payload.matchId);
        if (!seen || seen.createdAt <= r.createdAt)
          newest.set(r.payload.matchId, r);
      }
      return [...newest.values()].map((r) => ({
        matchId: r.payload.matchId,
        rowId: r.id,
        userId: r.userId,
        payload: r.payload,
        createdAt: r.createdAt,
      }));
    },
    jobMatch: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id === opts.throwsFor) throw new Error('database hiccup');
        return { ...baseMatch(where.id), notifiedAt: null };
      },
      update: async ({ where }: { where: { id: string } }) => {
        if (opts.updateFails) throw new Error('database write failed');
        calls.marked.push(where.id);
        return {};
      },
    },
    job: { count: async () => 5 },
    application: { findUnique: async () => null },
    notification: {
      findFirst: async ({
        where,
      }: {
        where: { userId: string; payload: { equals: string } };
      }) =>
        calls.rows
          .filter(
            (r) =>
              r.userId === where.userId &&
              r.payload.matchId === where.payload.equals,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
        null,
      create: async ({
        data,
      }: {
        data: { userId: string; payload: Record<string, unknown> };
      }) => {
        const row = {
          id: `notification-${++seq}`,
          userId: data.userId,
          payload: data.payload,
          createdAt: new Date(),
        };
        calls.rows.push(row);
        return { id: row.id };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { payload: Record<string, unknown> };
      }) => {
        const row = calls.rows.find((r) => r.id === where.id)!;
        row.payload = data.payload;
        return { id: row.id };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = calls.rows.find((r) => r.id === where.id);
        return row ? { payload: row.payload } : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; payload: { equals: number } };
        data: { payload: Record<string, unknown> };
      }) => {
        const race = opts.beforeFirstWrite;
        opts.beforeFirstWrite = undefined;
        race?.(calls.rows);
        const row = calls.rows.find((r) => r.id === where.id);
        const read = row ? parseDelivery(row.payload) : null;
        if (!row || !read?.ok || read.state.version !== where.payload.equals)
          return { count: 0 };
        row.payload = data.payload;
        return { count: 1 };
      },
    },
  };
  prisma.$transaction = async (fn: (tx: unknown) => unknown) => fn(prisma);

  const telegram = {
    isConfigured: () => opts.configured ?? true,
    heldReason: () => opts.held ?? null,
    send: async (_text: string, sendOpts: { buttons?: unknown[][] }) => {
      opts.onSend?.(calls.rows);
      const next = outcomes.shift() ?? 'ok';
      if (next !== 'ok')
        throw new TelegramSendError(
          next,
          `Telegram sendMessage -> simulated ${next}`,
        );
      calls.sends.push(sendOpts);
    },
  };
  /* eslint-enable @typescript-eslint/require-await */
  const config = {
    get: (key: string, fallback?: unknown) =>
      ({
        TELEGRAM_BOT_TOKEN: '12345:AAH-bot-token',
        CORS_ORIGIN: LOCAL,
        DASHBOARD_URL: opts.dashboard,
      })[key] ?? fallback,
  };

  const service = new NotificationsService(
    prisma as never,
    telegram as never,
    config as never,
  );
  const status = () =>
    calls.rows.map((r) => {
      const read = parseDelivery(r.payload);
      return read.ok ? read.state.status : 'MALFORMED';
    });
  /** An alert row written directly, as earlier code or a manual edit left it. */
  const seed = (matchId: string, delivery?: unknown) => {
    const row: Row = {
      id: `seeded-${matchId}`,
      userId: 'user-1',
      payload: {
        matchId,
        jobId: `job-${matchId}`,
        text: 'x',
        ...(delivery === undefined ? {} : { delivery }),
      },
      createdAt: new Date(Date.now() - 60_000),
    };
    calls.rows.push(row);
    return row;
  };
  /** Brings every RETRY forward to now, as if its wait had passed. */
  const makeDue = () => {
    for (const r of calls.rows) {
      const d = r.payload.delivery as { nextAttemptAt?: string } | undefined;
      if (d?.nextAttemptAt)
        d.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
    }
  };
  return { service, calls, status, makeDue, seed };
}

const buttonUrls = (send: { buttons?: unknown[][] }) =>
  (send.buttons ?? [])
    .flat()
    .map((b) => (b as { url?: string }).url)
    .filter((u): u is string => typeof u === 'string');

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('delivery contract', () => {
  it('marks the match notified once Telegram accepts the message', async () => {
    const { service, calls, status } = build();

    await expect(service.maybeNotifyMatch('match-1')).resolves.toBe(true);

    expect(calls.marked).toEqual(['match-1']);
    expect(status()).toEqual(['SENT']);
  });

  it('leaves the match unsent when Telegram rejects the message', async () => {
    const { service, calls } = build({ outcomes: ['rejected'] });

    await expect(service.maybeNotifyMatch('match-1')).resolves.toBe(false);

    expect(calls.marked).toEqual([]);
  });

  it('keeps one row per alert: a retry reuses it, so the in-app list shows the alert once', async () => {
    const { service, calls, makeDue } = build({ outcomes: ['server'] });

    await service.maybeNotifyMatch('match-1');
    makeDue();
    await service.retryUndelivered();

    expect(calls.rows).toHaveLength(1);
    expect(calls.sends).toHaveLength(1);
  });

  it('treats the in-app record as delivery when Telegram is not configured', async () => {
    const { service, calls, status } = build({ configured: false });

    await expect(service.maybeNotifyMatch('match-1')).resolves.toBe(true);

    expect(calls.marked).toEqual(['match-1']);
    expect(status()).toEqual(['SENT']);
  });
});

describe('dashboard button', () => {
  it('is left out for a localhost dashboard, which Telegram refuses', async () => {
    const { service, calls } = build({ dashboard: `${LOCAL}/` });

    await service.maybeNotifyMatch('match-1');

    expect(buttonUrls(calls.sends[0]).join(' ')).not.toContain('localhost');
  });

  it('is left out when no dashboard is configured, regardless of CORS_ORIGIN', async () => {
    const { service, calls } = build();

    await service.maybeNotifyMatch('match-1');

    expect(buttonUrls(calls.sends[0]).join(' ')).not.toContain('localhost');
  });

  it('links to the job on a public dashboard', async () => {
    const { service, calls } = build({ dashboard: `${PUBLIC}/` });

    await service.maybeNotifyMatch('match-1');

    expect(buttonUrls(calls.sends[0])).toContain(`${PUBLIC}/jobs/job-match-1`);
  });

  it('keeps the Apply link either way', async () => {
    const { service, calls } = build();

    await service.maybeNotifyMatch('match-1');

    expect(buttonUrls(calls.sends[0])).toContain('https://jobs.example.com/1');
  });
});

describe('what a failed send leaves behind', () => {
  it('a refused message (400) is FAILED and is never tried again', async () => {
    const { service, calls, status, makeDue } = build({
      outcomes: ['rejected'],
    });

    await service.maybeNotifyMatch('match-1');
    makeDue();
    await service.retryUndelivered();
    await service.maybeNotifyMatch('match-1');

    expect(status()).toEqual(['FAILED']);
    expect(calls.sends).toHaveLength(0);
  });

  it('a server error is RETRY: held until due, then sent once', async () => {
    const { service, calls, status, makeDue } = build({
      outcomes: ['server'],
    });

    await service.maybeNotifyMatch('match-1');
    expect(status()).toEqual(['RETRY']);

    await service.retryUndelivered(); // not due yet
    expect(calls.sends).toHaveLength(0);

    makeDue();
    await expect(service.retryUndelivered()).resolves.toBe(1);
    await service.retryUndelivered(); // already sent: nothing more
    expect(calls.sends).toHaveLength(1);
    expect(status()).toEqual(['SENT']);
  });

  it('an ambiguous send (timeout) is UNKNOWN and is never re-sent automatically', async () => {
    const { service, calls, status, makeDue } = build({
      outcomes: ['ambiguous'],
    });

    await service.maybeNotifyMatch('match-1');
    makeDue();
    await service.retryUndelivered();
    await service.maybeNotifyMatch('match-1');

    expect(status()).toEqual(['UNKNOWN']);
    expect(calls.sends).toHaveLength(0);
    expect(calls.marked).toEqual([]);
  });

  it('while sending is held for a configuration error, a new alert is recorded QUEUED and not sent', async () => {
    const { service, calls, status } = build({
      held: 'Telegram refused the bot configuration (401)',
    });

    await expect(service.maybeNotifyMatch('match-1')).resolves.toBe(false);

    expect(status()).toEqual(['QUEUED']);
    expect(calls.sends).toHaveLength(0);
  });
});

describe('a send that succeeded but could not be marked (the duplicate case)', () => {
  it('is sent once, however many times the notifiedAt write fails afterwards', async () => {
    const { service, calls, status } = build({ updateFails: true });

    await expect(service.maybeNotifyMatch('match-1')).rejects.toThrow(
      'database write failed',
    );
    for (let pass = 0; pass < 3; pass++) await service.retryUndelivered();

    expect(calls.sends).toHaveLength(1);
    expect(status()).toEqual(['SENT']);
  });

  it('is repaired, without a second message, once the write works again', async () => {
    const { service, calls } = build();
    await service.maybeNotifyMatch('match-1');
    calls.marked.length = 0; // as if that first write had failed

    await expect(service.retryUndelivered()).resolves.toBe(0);

    expect(calls.marked).toEqual(['match-1']);
    expect(calls.sends).toHaveLength(1);
  });
});

describe('retryUndelivered', () => {
  it('carries on after one alert throws', async () => {
    const { service, calls, seed } = build({ throwsFor: 'broken' });
    seed('broken', queued(new Date(Date.now() - 60_000)));
    seed('match-2', queued(new Date(Date.now() - 60_000)));

    await expect(service.retryUndelivered()).resolves.toBe(1);

    expect(calls.marked).toEqual(['match-2']);
  });

  it('while sending is held, attempts no send, but still settles what needs no channel', async () => {
    const { service, calls, seed } = build({
      held: 'Telegram refused the bot configuration (401)',
    });
    seed('waiting', queued(new Date(Date.now() - 60_000)));
    seed('arrived', {
      ...queued(new Date()),
      status: 'SENT',
      attempts: 1,
      version: 3,
    });
    const attempts = jest.spyOn(service, 'maybeNotifyMatch');

    await expect(service.retryUndelivered()).resolves.toBe(0);

    expect(attempts).not.toHaveBeenCalled();
    expect(calls.sends).toHaveLength(0);
    expect(calls.marked).toEqual(['arrived']);
  });

  it('sends at most 20 a pass, and settles every record that needs no send besides', async () => {
    const { service, calls, seed } = build();
    for (let i = 0; i < 25; i++)
      seed(`due-${String(i).padStart(2, '0')}`, {
        ...queued(new Date(Date.now() - 60_000)),
        nextAttemptAt: new Date(Date.now() - 60_000 + i).toISOString(),
      });
    seed('arrived', { ...queued(new Date()), status: 'SENT', version: 3 });

    await expect(service.retryUndelivered()).resolves.toBe(20);

    expect(calls.marked).toContain('arrived');
    expect(calls.sends).toHaveLength(20);
  });
});

describe('a malformed delivery record fails closed', () => {
  const good = {
    status: 'RETRY',
    attempts: 1,
    version: 2,
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
  };
  const malformed: [string, unknown][] = [
    ['a null record', null],
    ['a text record', 'RETRY'],
    ['an unknown status', { ...good, status: 'DELIVERED' }],
    ['a text version', { ...good, version: '2' }],
    ['no version', { ...good, version: undefined }],
    ['a nextAttemptAt that is not a time', { ...good, nextAttemptAt: 'soon' }],
  ];
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  it.each(malformed)(
    '%s: not sent, not overwritten, and named with its notification and match',
    async (_case, delivery) => {
      const { service, calls, seed } = build();
      const row = seed('match-1', delivery);
      const before = JSON.stringify(row.payload);

      await expect(service.maybeNotifyMatch('match-1')).resolves.toBe(false);

      expect(calls.sends).toHaveLength(0);
      expect(calls.marked).toEqual([]);
      expect(JSON.stringify(row.payload)).toBe(before);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/match match-1.*notification seeded-match-1/),
      );
    },
  );

  it.each(malformed)(
    '%s: held too when Telegram is not configured, not rewritten as in-app',
    async (_case, delivery) => {
      const { service, calls, seed } = build({ configured: false });
      const row = seed('match-1', delivery);
      const before = JSON.stringify(row.payload);

      await expect(service.maybeNotifyMatch('match-1')).resolves.toBe(false);

      expect(calls.marked).toEqual([]);
      expect(JSON.stringify(row.payload)).toBe(before);
    },
  );

  it.each(malformed)(
    '%s: never given a place in the retry pass, and named in its warning',
    async (_case, delivery) => {
      const { service, calls, seed } = build();
      seed('match-1', delivery);
      const attempts = jest.spyOn(service, 'maybeNotifyMatch');

      await expect(service.retryUndelivered()).resolves.toBe(0);

      expect(attempts).not.toHaveBeenCalled();
      expect(calls.sends).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('notification seeded-match-1 (match match-1)'),
      );
    },
  );

  it('a record that turned malformed during a send keeps it: the outcome is not written over it', async () => {
    const { service, calls } = build({
      onSend: (rows) => {
        rows[0].payload.delivery = { status: 'BROKEN' };
      },
    });

    await service.maybeNotifyMatch('match-1');

    expect(calls.sends).toHaveLength(1);
    expect(calls.rows[0].payload.delivery).toEqual({ status: 'BROKEN' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('is malformed (unknown status "BROKEN")'),
    );
  });
});

describe('every write to an existing record is a compare-and-set on the version read', () => {
  const bump = (status: string) => (rows: Row[]) => {
    const d = rows[0].payload.delivery as { version: number; status: string };
    rows[0].payload.delivery = { ...d, status, version: d.version + 1 };
  };

  it('claim() neither writes nor sends when the record changed after it read it', async () => {
    const { service, calls, seed } = build({ beforeFirstWrite: bump('RETRY') });
    seed('match-1', {
      ...queued(new Date(Date.now() - 60_000)),
      status: 'RETRY',
      version: 2,
    });

    await expect(service.maybeNotifyMatch('match-1')).resolves.toBe(false);

    expect(calls.sends).toHaveLength(0);
    expect(calls.rows[0].payload.delivery).toMatchObject({
      status: 'RETRY',
      version: 3,
    });
  });

  it('settle() keeps the SENT a stale send wrote after the pass read it as SENDING', async () => {
    const { service, calls, seed } = build({ beforeFirstWrite: bump('SENT') });
    seed('match-1', {
      status: 'SENDING',
      attempts: 0,
      version: 2,
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      channel: 'telegram',
    });

    await service.retryUndelivered();

    expect(calls.rows[0].payload.delivery).toMatchObject({
      status: 'SENT',
      version: 3,
    });
    expect(calls.sends).toHaveLength(0);
  });
});
