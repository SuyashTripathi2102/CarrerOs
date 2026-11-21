import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { NotificationsService } from './notifications.service';

/**
 * Alert delivery against a real Postgres: the delivery record, the retry query,
 * the per-alert advisory lock and real concurrency. A fake Telegram channel
 * stands in for the network; everything else is the real service and database.
 *
 * Needs a THROWAWAY database, never a live one:
 *   W2_INT_DATABASE_URL  the current schema, no rows
 * Every test starts by truncating users and companies (and with them every
 * match, job and notification), so the suite refuses to run, before any
 * truncation, unless all of these hold:
 *   - the database is named THROWAWAY_DB;
 *   - it is marked `ALTER DATABASE ... SET careeros.throwaway = 'w2'`;
 *   - it holds no user or company row this suite did not create;
 *   - the URL is not the application's DATABASE_URL.
 * The first three are checked again inside the database, in the same statement
 * as the TRUNCATE (GUARDED_TRUNCATE), so nothing in this file can truncate
 * without them. Without the variable the suite is skipped.
 *
 * W2_VARIANT=original runs the same file against the code before the fix: the
 * three regression tests are expected to FAIL there (that is the
 * demonstration), and the tests that read the delivery record are skipped.
 * W2_VARIANT=round2 runs it against the second round of the fix: the C and Q
 * tests are expected to FAIL there. The file reads delivery records with SQL,
 * not with the code under test, so the same assertions apply to every variant.
 */

const THROWAWAY_DB = 'w2_int';
const THROWAWAY_MARKER = 'w2';
const OWN_EMAIL = 'w2-%@example.test'; // LIKE: every user seed() creates
const OWN_COMPANY = 'Acme %'; // LIKE: every company seed() creates

const GUARDED_TRUNCATE = `
DO $guard$
BEGIN
  IF current_database() <> '${THROWAWAY_DB}' THEN
    RAISE EXCEPTION 'refusing to truncate: database % is not ${THROWAWAY_DB}', current_database();
  END IF;
  IF current_setting('careeros.throwaway', true) IS DISTINCT FROM '${THROWAWAY_MARKER}' THEN
    RAISE EXCEPTION 'refusing to truncate: database % is not marked as the W2 throwaway', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE email NOT LIKE '${OWN_EMAIL}')
     OR EXISTS (SELECT 1 FROM companies WHERE name NOT LIKE '${OWN_COMPANY}') THEN
    RAISE EXCEPTION 'refusing to truncate: database % holds rows this suite did not create', current_database();
  END IF;
  TRUNCATE users, companies RESTART IDENTITY CASCADE;
END
$guard$`;

const URL = process.env.W2_INT_DATABASE_URL;
const ORIGINAL = process.env.W2_VARIANT === 'original';
const describeDb = URL ? describe : describe.skip;
const itFixed = ORIGINAL ? it.skip : it;

// Present only in the fixed code; resolved at run time so the original tree compiles.
/* eslint-disable @typescript-eslint/no-require-imports */
type SendErrorClass = new (
  failure: string,
  message: string,
  status?: number,
  retryAfterSec?: number,
) => Error;
const channelsModule: unknown = require('./channels');
const SendError: SendErrorClass =
  (channelsModule as { TelegramSendError?: SendErrorClass })
    .TelegramSendError ?? Error;
/* eslint-enable @typescript-eslint/no-require-imports */

/** A delivery record as stored, read with SQL. */
type Stored = {
  status: string;
  attempts: number;
  version: number;
  nextAttemptAt?: string;
} | null;

type Outcome =
  'ok' | { failure: string; status?: number; retryAfterSec?: number };

/**
 * Telegram stand-in. Decides per message by the job title in its text and, like
 * the real channel, holds every later send after a configuration refusal.
 */
class FakeTelegram {
  readonly sent: string[] = [];
  /** Every send the service attempted, delivered or not. */
  attempts = 0;
  private readonly plans = new Map<string, Outcome[]>();
  delayMs = 0;
  held: string | null = null;

  plan(titlePrefix: string, ...outcomes: Outcome[]) {
    this.plans.set(titlePrefix, outcomes);
  }
  isConfigured() {
    return true;
  }
  heldReason() {
    return this.held;
  }
  async send(text: string) {
    this.attempts++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    // formatMatch puts the job title, in bold, on the third line.
    const title =
      /<b>([^<]+)<\/b>/.exec(text.split('\n')[2] ?? '')?.[1] ?? text;
    const key = [...this.plans.keys()].find((k) => title.startsWith(k));
    const next = key ? (this.plans.get(key)!.shift() ?? 'ok') : 'ok';
    if (next !== 'ok' && next.failure === 'config')
      this.held = 'Telegram refused the bot configuration';
    if (next !== 'ok')
      throw new SendError(
        next.failure,
        `Telegram sendMessage -> simulated ${next.failure}`,
        next.status,
        next.retryAfterSec,
      );
    this.sent.push(title);
  }
}

/** The real client, except that jobMatch.update throws while `state.fail` is set. */
function withFailingMatchWrites(
  prisma: PrismaClient,
  state: { fail: boolean },
): PrismaClient {
  const jobMatch = new Proxy(prisma.jobMatch, {
    get(target, prop) {
      if (prop === 'update' && state.fail) {
        return () =>
          Promise.reject(new Error('simulated database write failure'));
      }
      return bound(target, prop);
    },
  });
  return new Proxy(prisma, {
    get(target, prop) {
      if (prop === 'jobMatch') return jobMatch;
      return bound(target, prop);
    },
  });
}

/** A property of `target`, with methods bound to it, as the real client expects. */
function bound(target: object, prop: string | symbol): unknown {
  const value: unknown = Reflect.get(target, prop);
  return typeof value === 'function'
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
}

/**
 * The real client, except that inside a transaction the first
 * `notification.<method>` call, once it has returned, waits for `release()`.
 * `reached` resolves at that moment: the transaction has read the record and
 * holds the per-alert lock, and has written nothing yet.
 */
function pausingAfterRead(
  prisma: PrismaClient,
  method: 'findFirst' | 'findUnique',
) {
  let markReached = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => (markReached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let used = false;
  const notifications = (delegate: object) =>
    new Proxy(delegate, {
      get(target, prop) {
        const value = bound(target, prop);
        if (prop !== method || used || typeof value !== 'function')
          return value;
        return async (...args: unknown[]) => {
          used = true;
          const result: unknown = await (
            value as (...a: unknown[]) => Promise<unknown>
          )(...args);
          markReached();
          await released;
          return result;
        };
      },
    });
  const client = new Proxy(prisma, {
    get(target, prop) {
      if (prop !== '$transaction') return bound(target, prop);
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(t, p) {
                const value = bound(t, p);
                return p === 'notification'
                  ? notifications(value as object)
                  : value;
              },
            }),
          ),
        );
    },
  });
  return { client, reached, release };
}

/**
 * The real client, except that every $queryRaw (only the retry query uses it)
 * records how many rows it returned and how long it took, and fails the pass
 * at once if it returned more than `limit` rows.
 */
function measuringQueries(
  prisma: PrismaClient,
  limit: number,
  seen: { rows: number; ms: number }[],
) {
  return new Proxy(prisma, {
    get(target, prop) {
      const value = bound(target, prop);
      if (prop !== '$queryRaw' || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const started = performance.now();
        const rows = (await (value as (...a: unknown[]) => Promise<unknown>)(
          ...args,
        )) as unknown[];
        seen.push({ rows: rows.length, ms: performance.now() - started });
        if (rows.length > limit)
          throw new Error(
            `the retry query returned ${rows.length} rows, more than ${limit}`,
          );
        return rows;
      };
    },
  });
}

/** Resolves with `promise`, or fails after `seconds` with `what`. */
async function within<T>(promise: Promise<T>, seconds: number, what: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(what)), seconds * 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const config = {
  get: (key: string, fallback?: unknown) =>
    (
      ({
        TELEGRAM_BOT_TOKEN: '12345:AAH-int-test',
        NOTIFY_MIN_SCORE: 70,
      }) as Record<string, unknown>
    )[key] ?? fallback,
};

describeDb('alert delivery against Postgres', () => {
  let prisma: PrismaClient;
  let seq = 0;

  beforeAll(async () => {
    if (URL === process.env.DATABASE_URL)
      throw new Error(
        "refusing to run: W2_INT_DATABASE_URL is the application's database",
      );
    prisma = new PrismaClient({ datasourceUrl: URL });
    const [db] = await prisma.$queryRaw<
      { name: string; marker: string | null; strangers: boolean }[]
    >`
      SELECT current_database() AS name,
             current_setting('careeros.throwaway', true) AS marker,
             EXISTS (SELECT 1 FROM users WHERE email NOT LIKE ${OWN_EMAIL})
               OR EXISTS (SELECT 1 FROM companies WHERE name NOT LIKE ${OWN_COMPANY})
               AS strangers`;
    const refusal =
      db.name !== THROWAWAY_DB
        ? `the database is ${db.name}, not ${THROWAWAY_DB}`
        : db.marker !== THROWAWAY_MARKER
          ? `${db.name} is not marked as the W2 throwaway`
          : db.strangers
            ? `${db.name} holds rows this suite did not create`
            : null;
    if (refusal) throw new Error(`refusing to run: ${refusal}`);
  });
  afterAll(() => prisma?.$disconnect());
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(GUARDED_TRUNCATE);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /** A user with an embedded-resume chain and one APPLY match per title, decided `ageMin` minutes ago. */
  async function seed(alerts: { title: string; ageMin: number }[]) {
    const user = await prisma.user.create({
      data: { email: `w2-${++seq}@example.test` },
    });
    const resume = await prisma.resume.create({ data: { userId: user.id } });
    const version = await prisma.resumeVersion.create({
      data: { resumeId: resume.id, versionNumber: 1, fileKey: 'k' },
    });
    const company = await prisma.company.create({
      data: { name: `Acme ${seq}` },
    });
    const ids: Record<string, string> = {};
    const jobIds: Record<string, string> = {};
    for (const [i, a] of alerts.entries()) {
      const job = await prisma.job.create({
        data: {
          companyId: company.id,
          externalId: `ext-${seq}-${i}`,
          title: a.title,
          description: 'd',
          url: `https://jobs.example.com/${seq}/${i}`,
          country: 'IN',
          location: 'Bengaluru',
          postedAt: new Date(),
        },
      });
      const match = await prisma.jobMatch.create({
        data: {
          userId: user.id,
          jobId: job.id,
          resumeVersionId: version.id,
          overallScore: 80,
          technicalScore: 80,
          experienceScore: 80,
          opportunityScore: 90,
          verdict: 'APPLY',
          verdictCode: 'TARGET_ROLE_ELIGIBLE',
          verdictReason: 'Strong match',
          decidedAt: new Date(Date.now() - a.ageMin * 60_000),
        },
      });
      ids[a.title] = match.id;
      jobIds[a.title] = job.id;
    }
    return { userId: user.id, ids, jobIds };
  }

  /** An alert row with this delivery record, as earlier code or a manual edit left it. */
  const alertRow = (userId: string, matchId: string, delivery: unknown) =>
    prisma.notification.create({
      data: {
        userId,
        type: 'NEW_MATCHES',
        payload: { matchId, text: 'x', delivery } as Prisma.InputJsonValue,
      },
    });
  const iso = (minAgo: number) =>
    new Date(Date.now() - minAgo * 60_000).toISOString();

  /** Every RETRY becomes due now, as if its wait had passed. A no-op for the original code. */
  const makeDue = () => prisma.$executeRaw`
    UPDATE notifications
    SET payload = jsonb_set(payload, '{delivery,nextAttemptAt}',
      to_jsonb(to_char((now() - interval '1 minute') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    WHERE payload->'delivery'->>'status' = 'RETRY'`;

  /** The stored delivery records of a match's alerts, newest first, read with SQL. */
  const stateOf = async (matchId: string) => {
    const rows = await prisma.$queryRaw<{ d: Stored }[]>`
      SELECT payload->'delivery' AS d FROM notifications
      WHERE payload->>'matchId' = ${matchId} ORDER BY "createdAt" DESC`;
    return rows.map((r) => r.d);
  };
  const newService = (telegram: FakeTelegram) =>
    new NotificationsService(
      prisma as never,
      telegram as never,
      config as never,
    );
  /** RETRY, refused or failed earlier, with `minAgo` minutes since it fell due. */
  const dueRetry = (minAgo: number) => ({
    status: 'RETRY',
    attempts: 1,
    version: 3,
    updatedAt: iso(90),
    nextAttemptAt: iso(minAgo),
  });
  /** What the send writes when it returns, through the service's own outcome writer. */
  const recordSent = (rowId: string, claimedVersion: number) =>
    (
      newService(new FakeTelegram()) as unknown as {
        record(rowId: string, version: number, next: unknown): Promise<void>;
      }
    ).record(rowId, claimedVersion, {
      status: 'SENT',
      attempts: 1,
      version: claimedVersion,
      updatedAt: new Date().toISOString(),
      channel: 'telegram',
    });
  const named = (prefix: string, count: number) =>
    Array.from(
      { length: count },
      (_, i) => `${prefix} ${String(i).padStart(3, '0')}`,
    );
  /** It is RETRY, untouched in status and attempts, and not due for most of an hour. */
  const expectMovedBack = async (title: string, matchId: string) => {
    const [s] = await stateOf(matchId);
    expect([title, s?.status, s?.attempts]).toEqual([title, 'RETRY', 1]);
    expect(Date.parse(s!.nextAttemptAt!)).toBeGreaterThan(
      Date.now() + 55 * 60_000,
    );
  };
  const notifiedAt = async (matchId: string) =>
    (
      await prisma.jobMatch.findUniqueOrThrow({
        where: { id: matchId },
        select: { notifiedAt: true },
      })
    ).notifiedAt;

  // ── Regression tests: the failures reproduced on 2026-11-12 ─────────────────

  it('REG-1: a send that succeeded but could not be marked is not sent again', async () => {
    const telegram = new FakeTelegram();
    const writes = { fail: true };
    const service = new NotificationsService(
      withFailingMatchWrites(prisma, writes) as never,
      telegram as never,
      config as never,
    );
    const { ids } = await seed([{ title: 'Backend Engineer', ageMin: 60 }]);

    await service
      .maybeNotifyMatch(ids['Backend Engineer'])
      .catch(() => undefined);
    for (let pass = 0; pass < 3; pass++) await service.retryUndelivered();

    expect(telegram.sent).toHaveLength(1);
  });

  it('REG-2: twenty alerts refused for good cannot starve an older deliverable one', async () => {
    const telegram = new FakeTelegram();
    const service = new NotificationsService(
      prisma as never,
      telegram as never,
      config as never,
    );
    const alerts = [{ title: 'Deliverable Role', ageMin: 120 }];
    for (let i = 0; i < 20; i++)
      alerts.push({
        title: `Perm Role ${String(i).padStart(2, '0')}`,
        ageMin: 60 - i,
      });
    const { ids } = await seed(alerts);
    telegram.plan(
      'Perm Role',
      ...Array.from({ length: 200 }, (): Outcome => ({
        failure: 'rejected',
        status: 400,
      })),
    );
    telegram.plan('Deliverable Role', { failure: 'server', status: 503 });

    for (const a of alerts) await service.maybeNotifyMatch(ids[a.title]);
    await makeDue();
    for (let pass = 0; pass < 3; pass++) await service.retryUndelivered();

    expect(telegram.sent.filter((t) => t === 'Deliverable Role')).toHaveLength(
      1,
    );
  });

  it('REG-3: two retry passes at the same time send an alert once', async () => {
    const telegram = new FakeTelegram();
    const service = new NotificationsService(
      prisma as never,
      telegram as never,
      config as never,
    );
    const { ids } = await seed([{ title: 'Backend Engineer', ageMin: 60 }]);
    telegram.plan('Backend Engineer', { failure: 'server', status: 503 });
    await service.maybeNotifyMatch(ids['Backend Engineer']);
    await makeDue();

    telegram.delayMs = 300;
    await Promise.all([service.retryUndelivered(), service.retryUndelivered()]);

    expect(telegram.sent).toHaveLength(1);
  });

  // ── The delivery record, the retry query and the lock (fixed code only) ──────

  itFixed('two first attempts at the same new alert send it once', async () => {
    const telegram = new FakeTelegram();
    telegram.delayMs = 300;
    const service = new NotificationsService(
      prisma as never,
      telegram as never,
      config as never,
    );
    const { ids } = await seed([{ title: 'Backend Engineer', ageMin: 1 }]);

    await Promise.all([
      service.maybeNotifyMatch(ids['Backend Engineer']),
      service.maybeNotifyMatch(ids['Backend Engineer']),
    ]);

    expect(telegram.sent).toHaveLength(1);
    expect(
      (await stateOf(ids['Backend Engineer'])).map((s) => s?.status),
    ).toEqual(['SENT']);
  });

  itFixed(
    'each Telegram failure leaves the record it should, and the match unsent',
    async () => {
      const cases: [string, Outcome, string][] = [
        ['A refused', { failure: 'rejected', status: 400 }, 'FAILED'],
        ['B server', { failure: 'server', status: 502 }, 'RETRY'],
        [
          'C limited',
          { failure: 'rate-limited', status: 429, retryAfterSec: 35 },
          'RETRY',
        ],
        ['D unreached', { failure: 'not-sent' }, 'RETRY'],
        ['E timeout', { failure: 'ambiguous' }, 'UNKNOWN'],
        ['F config', { failure: 'config', status: 401 }, 'RETRY'],
      ];
      const telegram = new FakeTelegram();
      const service = new NotificationsService(
        prisma as never,
        telegram as never,
        config as never,
      );
      const { ids } = await seed(
        cases.map(([title]) => ({ title, ageMin: 60 })),
      );
      for (const [title, outcome] of cases) telegram.plan(title, outcome);

      for (const [title] of cases) await service.maybeNotifyMatch(ids[title]);

      for (const [title, , expected] of cases) {
        const [state] = await stateOf(ids[title]);
        expect([title, state?.status]).toEqual([title, expected]);
        expect(await notifiedAt(ids[title])).toBeNull();
      }
      const wait = async (title: string) =>
        Date.parse((await stateOf(ids[title]))[0]!.nextAttemptAt!) - Date.now();
      expect(await wait('B server')).toBeGreaterThan(9 * 60_000);
      expect(await wait('C limited')).toBeLessThan(36_000);
      expect(await wait('F config')).toBeGreaterThan(59 * 60_000);
      expect((await stateOf(ids['F config']))[0]!.attempts).toBe(0);
    },
  );

  itFixed(
    'an interrupted send (SENDING, long stale) is resolved to UNKNOWN and not re-sent',
    async () => {
      const telegram = new FakeTelegram();
      const service = new NotificationsService(
        prisma as never,
        telegram as never,
        config as never,
      );
      const { userId, ids } = await seed([
        { title: 'Backend Engineer', ageMin: 60 },
      ]);
      const stale = new Date(Date.now() - 10 * 60_000).toISOString();
      await prisma.notification.create({
        data: {
          userId,
          type: 'NEW_MATCHES',
          payload: {
            matchId: ids['Backend Engineer'],
            text: 'x',
            delivery: {
              status: 'SENDING',
              attempts: 0,
              version: 2,
              updatedAt: stale,
            },
          },
        },
      });

      await service.retryUndelivered();
      await service.retryUndelivered();

      expect(telegram.sent).toHaveLength(0);
      expect(
        (await stateOf(ids['Backend Engineer'])).map((s) => s?.status),
      ).toEqual(['UNKNOWN']);
    },
  );

  itFixed(
    'an alert held while sending was blocked (QUEUED) is sent once sending works again',
    async () => {
      const telegram = new FakeTelegram();
      telegram.held = 'Telegram refused the bot configuration (401)';
      const service = new NotificationsService(
        prisma as never,
        telegram as never,
        config as never,
      );
      const { ids } = await seed([{ title: 'Backend Engineer', ageMin: 60 }]);

      await service.maybeNotifyMatch(ids['Backend Engineer']);
      expect(
        (await stateOf(ids['Backend Engineer'])).map((s) => s?.status),
      ).toEqual(['QUEUED']);

      telegram.held = null; // as after a restart with a corrected token
      await service.retryUndelivered();
      await service.retryUndelivered();

      expect(telegram.sent).toEqual(['Backend Engineer']);
      expect(await notifiedAt(ids['Backend Engineer'])).not.toBeNull();
    },
  );

  itFixed(
    'the retry query takes the oldest due first, at most 20, and never FAILED or UNKNOWN',
    async () => {
      const telegram = new FakeTelegram();
      const service = new NotificationsService(
        prisma as never,
        telegram as never,
        config as never,
      );
      const titles = Array.from(
        { length: 25 },
        (_, i) => `Due ${String(i).padStart(2, '0')}`,
      );
      const { userId, ids } = await seed(
        [...titles, 'Gone A', 'Gone B', 'Maybe A'].map((title) => ({
          title,
          ageMin: 60,
        })),
      );
      const row = (title: string, d: Record<string, unknown>) =>
        alertRow(userId, ids[title], { version: 2, attempts: 1, ...d });
      // Due 00 has waited longest: its nextAttemptAt is the earliest.
      for (const [i, title] of titles.entries())
        await row(title, {
          status: 'RETRY',
          updatedAt: iso(90),
          nextAttemptAt: iso(60 - i),
        });
      await row('Gone A', { status: 'FAILED', updatedAt: iso(90) });
      await row('Gone B', { status: 'FAILED', updatedAt: iso(90) });
      await row('Maybe A', { status: 'UNKNOWN', updatedAt: iso(90) });

      await expect(service.retryUndelivered()).resolves.toBe(20);

      expect(telegram.sent).toEqual(titles.slice(0, 20));
      expect(telegram.sent).not.toEqual(
        expect.arrayContaining(['Gone A', 'Gone B', 'Maybe A']),
      );
    },
  );

  itFixed(
    'a row from before the delivery record existed is repaired, not re-sent',
    async () => {
      const telegram = new FakeTelegram();
      const service = new NotificationsService(
        prisma as never,
        telegram as never,
        config as never,
      );
      const { userId, ids } = await seed([
        { title: 'Backend Engineer', ageMin: 60 },
      ]);
      await prisma.notification.create({
        data: {
          userId,
          type: 'NEW_MATCHES',
          payload: {
            matchId: ids['Backend Engineer'],
            jobId: 'j',
            text: 'sent by the earlier code',
          },
        },
      });

      await expect(service.retryUndelivered()).resolves.toBe(0);

      expect(telegram.sent).toHaveLength(0);
      expect(await notifiedAt(ids['Backend Engineer'])).not.toBeNull();
    },
  );

  itFixed(
    'an APPLY match held by a gate never enters the retry queue',
    async () => {
      const telegram = new FakeTelegram();
      const service = new NotificationsService(
        prisma as never,
        telegram as never,
        config as never,
      );
      const { userId, ids } = await seed([
        { title: 'Backend Engineer', ageMin: 60 },
      ]);
      await prisma.userPreference.create({
        data: { userId, countries: ['US'] },
      }); // the job is in India

      await service.maybeNotifyMatch(ids['Backend Engineer']);
      await expect(service.retryUndelivered()).resolves.toBe(0);

      expect(telegram.sent).toHaveLength(0);
      expect(await stateOf(ids['Backend Engineer'])).toEqual([]);
    },
  );

  // ── Round 2: the three blockers (fixed code only; expected to FAIL on round 1) ─

  itFixed(
    'B1: a malformed or unknown record is never sent or written, and takes no place in the retry pass',
    async () => {
      const telegram = new FakeTelegram();
      const service = newService(telegram);
      // Each looks due: were it read as a record, it would be sent.
      const looksDue = dueRetry(30);
      const omit = (key: string) =>
        Object.fromEntries(Object.entries(looksDue).filter(([k]) => k !== key));
      const malformed: [string, unknown][] = [
        ['Null record', null],
        ['Text record', 'SENT'],
        ['List record', []],
        ['Unknown status', { ...looksDue, status: 'DELIVERED' }],
        ['Lower-case status', { ...looksDue, status: 'retry' }],
        ['Numeric status', { ...looksDue, status: 1 }],
        ['No status', omit('status')],
        ['No version', omit('version')],
        ['Text version', { ...looksDue, version: '3' }],
        ['Zero version', { ...looksDue, version: 0 }],
        ['Fractional version', { ...looksDue, version: 1.5 }],
        ['No attempts', omit('attempts')],
        ['Negative attempts', { ...looksDue, attempts: -1 }],
        ['Bad updatedAt', { ...looksDue, updatedAt: 'yesterday' }],
        ['Bad nextAttemptAt', { ...looksDue, nextAttemptAt: 'soon' }],
        ['Null nextAttemptAt', { ...looksDue, nextAttemptAt: null }],
        [
          'Hour-24 nextAttemptAt',
          { ...looksDue, nextAttemptAt: '2026-11-12T24:00:00.000Z' },
        ],
        [
          'February-30 nextAttemptAt',
          { ...looksDue, nextAttemptAt: '2026-02-30T10:00:00.000Z' },
        ],
        ['Unknown channel', { ...looksDue, channel: 'sms' }],
        ['Numeric lastError', { ...looksDue, lastError: 502 }],
        [
          'Stale sending with a bad time',
          { ...looksDue, status: 'SENDING', updatedAt: 'long ago' },
        ],
      ];
      const { userId, ids } = await seed(
        [...malformed.map(([title]) => title), 'Deliverable Role'].map(
          (title) => ({ title, ageMin: 60 }),
        ),
      );
      for (const [title, d] of malformed) await alertRow(userId, ids[title], d);
      // Due more recently than all of them: last in line, were they in it.
      await alertRow(userId, ids['Deliverable Role'], dueRetry(1));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const errors = jest.spyOn(Logger.prototype, 'error');

      for (const [title] of malformed)
        await expect(service.maybeNotifyMatch(ids[title])).resolves.toBe(false);
      const attempts = jest.spyOn(service, 'maybeNotifyMatch');
      await expect(service.retryUndelivered()).resolves.toBe(1);
      await expect(service.retryUndelivered()).resolves.toBe(0);

      expect(telegram.sent).toEqual(['Deliverable Role']);
      // The passes attempted only the valid alert, and the query and
      // parseDelivery() never judged a record differently.
      expect(attempts.mock.calls).toEqual([[ids['Deliverable Role']]]);
      expect(errors).not.toHaveBeenCalledWith(
        expect.stringContaining('by the query and as'),
      );
      for (const [title, d] of malformed) {
        expect([title, await stateOf(ids[title])]).toEqual([title, [d]]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            `alert for match ${ids[title]}: the delivery record on notification`,
          ),
        );
      }
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `alert retry: ${malformed.length} malformed delivery record(s)`,
        ),
      );
    },
  );

  itFixed(
    'B2: while sending is held, 25 held due alerts cannot keep an alert that needs no channel waiting',
    async () => {
      const telegram = new FakeTelegram();
      telegram.held = 'Telegram refused the bot configuration (401)';
      const service = newService(telegram);
      const held = Array.from(
        { length: 25 },
        (_, i) => `Held ${String(i).padStart(2, '0')}`,
      );
      const { userId, ids } = await seed(
        [...held, 'Arrived Role'].map((title) => ({ title, ageMin: 60 })),
      );
      // Refused for configuration an hour ago (RETRY, not counted), due again now.
      for (const [i, title] of held.entries())
        await alertRow(userId, ids[title], {
          ...dueRetry(30 - i),
          attempts: 0,
          lastError: 'Telegram sendMessage -> 401: Unauthorized',
        });
      // Arrived, but its match was never marked; it is the newest in line.
      await alertRow(userId, ids['Arrived Role'], {
        status: 'SENT',
        attempts: 1,
        version: 3,
        updatedAt: iso(1),
      });

      await service.retryUndelivered(); // still held

      expect(await notifiedAt(ids['Arrived Role'])).not.toBeNull();
      expect(telegram.attempts).toBe(0);
      for (const title of held)
        expect([title, (await stateOf(ids[title]))[0]]).toMatchObject([
          title,
          { status: 'RETRY', version: 3 },
        ]);

      telegram.held = null; // the restart with a corrected token
      await service.retryUndelivered();
      await service.retryUndelivered();

      expect([...telegram.sent].sort()).toEqual(held);
    },
  );

  itFixed(
    'B2: due alerts a gate now holds are moved back, so 25 of them cannot keep a deliverable alert waiting',
    async () => {
      const telegram = new FakeTelegram();
      const service = newService(telegram);
      const applied = Array.from(
        { length: 25 },
        (_, i) => `Applied ${String(i).padStart(2, '0')}`,
      );
      const { userId, ids, jobIds } = await seed(
        [...applied, 'Deliverable Role'].map((title) => ({
          title,
          ageMin: 60,
        })),
      );
      for (const [i, title] of applied.entries()) {
        // Applied to since the alert was queued: the "already acted on" gate holds it.
        await prisma.application.create({
          data: { userId, jobId: jobIds[title], status: 'APPLIED' },
        });
        await alertRow(userId, ids[title], dueRetry(30 - i));
      }
      await alertRow(userId, ids['Deliverable Role'], dueRetry(1));

      await service.retryUndelivered(); // the 20 waiting longest: all held by the gate
      await service.retryUndelivered(); // the other 5, and the deliverable one

      expect(telegram.sent).toEqual(['Deliverable Role']);
      for (const title of applied) await expectMovedBack(title, ids[title]);
      const attempts = jest.spyOn(service, 'maybeNotifyMatch');
      await service.retryUndelivered();
      expect(attempts).not.toHaveBeenCalled(); // none is picked again yet
    },
  );

  itFixed(
    'B2: when sending becomes held part-way through a pass, the rest of that pass is moved back, not left due',
    async () => {
      const telegram = new FakeTelegram();
      const service = newService(telegram);
      const titles = ['Role A', 'Role B', 'Role C', 'Role D', 'Role E'];
      const { userId, ids } = await seed(
        titles.map((title) => ({ title, ageMin: 60 })),
      );
      for (const [i, title] of titles.entries())
        await alertRow(userId, ids[title], dueRetry(30 - i));
      telegram.plan('Role A', { failure: 'config', status: 401 });

      await service.retryUndelivered();

      expect(telegram.attempts).toBe(1); // Role A; then the channel is held
      for (const title of titles) await expectMovedBack(title, ids[title]);
      await makeDue();
      await service.retryUndelivered(); // still held: no send is attempted
      expect(telegram.attempts).toBe(1);

      telegram.held = null; // the restart with a corrected token
      await service.retryUndelivered();
      expect([...telegram.sent].sort()).toEqual(titles);
    },
  );

  // ── Round 3: the stale-send race and the bounded query (FAIL on round 2) ─────

  itFixed(
    'C1: recovering a stale send in the retry pass cannot overwrite the SENT that send wrote meanwhile',
    async () => {
      const telegram = new FakeTelegram();
      const { userId, ids } = await seed([
        { title: 'Backend Engineer', ageMin: 60 },
      ]);
      const matchId = ids['Backend Engineer'];
      // Claimed 10 minutes ago, and the laptop slept mid-send.
      const row = await alertRow(userId, matchId, {
        status: 'SENDING',
        attempts: 0,
        version: 2,
        updatedAt: iso(10),
        channel: 'telegram',
      });
      const paused = pausingAfterRead(prisma, 'findUnique');
      const service = new NotificationsService(
        paused.client as never,
        telegram as never,
        config as never,
      );

      const pass = service.retryUndelivered();
      await within(paused.reached, 10, 'the pass never read the record');
      // The pass has read SENDING v2 and holds the lock. The send wakes up and
      // records its outcome, which does not take the lock: SENT v3.
      await recordSent(row.id, 2);
      paused.release();
      await pass;

      expect((await stateOf(matchId))[0]).toMatchObject({
        status: 'SENT',
        version: 3,
      });
      await newService(telegram).retryUndelivered(); // settles what it says
      expect(await notifiedAt(matchId)).not.toBeNull();
      expect(telegram.attempts).toBe(0);
    },
  );

  itFixed(
    'C2: recovering a stale send in claim() cannot overwrite the SENT that send wrote meanwhile',
    async () => {
      const telegram = new FakeTelegram();
      const { userId, ids } = await seed([
        { title: 'Backend Engineer', ageMin: 60 },
      ]);
      const matchId = ids['Backend Engineer'];
      const row = await alertRow(userId, matchId, {
        status: 'SENDING',
        attempts: 0,
        version: 2,
        updatedAt: iso(10),
        channel: 'telegram',
      });
      const paused = pausingAfterRead(prisma, 'findFirst');
      const service = new NotificationsService(
        paused.client as never,
        telegram as never,
        config as never,
      );

      const attempt = service.maybeNotifyMatch(matchId);
      await within(paused.reached, 10, 'claim() never read the record');
      await recordSent(row.id, 2);
      paused.release();

      await expect(attempt).resolves.toBe(false);
      expect((await stateOf(matchId))[0]).toMatchObject({
        status: 'SENT',
        version: 3,
      });
      expect(telegram.attempts).toBe(0);
    },
  );

  itFixed(
    'Q1: a pass reads at most 20 sends, 50 settlements and 5 malformed rows; the rest follow, oldest first',
    async () => {
      const telegram = new FakeTelegram();
      const seen: { rows: number; ms: number }[] = [];
      const service = new NotificationsService(
        measuringQueries(prisma, 75, seen) as never,
        telegram as never,
        config as never,
      );
      const due = named('Due', 30);
      const arrived = named('Arrived', 55);
      const broken = named('Broken', 7);
      const { userId, ids } = await seed(
        [...due, ...arrived, ...broken].map((title) => ({
          title,
          ageMin: 60,
        })),
      );
      for (const [i, title] of due.entries())
        await alertRow(userId, ids[title], dueRetry(60 - i));
      for (const title of arrived)
        await alertRow(userId, ids[title], {
          status: 'SENT',
          attempts: 1,
          version: 3,
          updatedAt: iso(30),
        });
      for (const title of broken)
        await alertRow(userId, ids[title], { ...dueRetry(30), version: 'x' });
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const marked = () =>
        prisma.jobMatch.count({
          where: {
            id: { in: arrived.map((t) => ids[t]) },
            notifiedAt: { not: null },
          },
        });

      await expect(service.retryUndelivered()).resolves.toBe(20);
      expect(seen.map((q) => q.rows)).toEqual([20 + 50 + 5]);
      expect(telegram.sent).toEqual(due.slice(0, 20)); // oldest due first
      expect(await marked()).toBe(50);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('alert retry: 7 malformed delivery record(s)'),
      );

      await expect(service.retryUndelivered()).resolves.toBe(10);
      expect(seen.map((q) => q.rows)).toEqual([75, 10 + 5 + 5]);
      expect(telegram.sent).toEqual(due);
      expect(await marked()).toBe(55);
    },
    60_000,
  );

  itFixed(
    'Q2: with 20,000 open alerts, the retry query still reads at most 75 rows',
    async () => {
      const telegram = new FakeTelegram();
      const seen: { rows: number; ms: number }[] = [];
      const service = new NotificationsService(
        measuringQueries(prisma, 75, seen) as never,
        telegram as never,
        config as never,
      );
      const user = await prisma.user.create({
        data: { email: `w2-scale@example.test` },
      });
      const resume = await prisma.resume.create({ data: { userId: user.id } });
      const version = await prisma.resumeVersion.create({
        data: { resumeId: resume.id, versionNumber: 1, fileKey: 'k' },
      });
      const company = await prisma.company.create({
        data: { name: 'Acme scale' },
      });
      const N = 20_000;
      // 8,000 due, 8,000 arrived but unmarked, 2,000 malformed, 2,000 not yet due.
      const deliveryOf = (i: number): unknown =>
        i < 8_000
          ? dueRetry(600 - (i % 500))
          : i < 16_000
            ? { status: 'SENT', attempts: 1, version: 3, updatedAt: iso(30) }
            : i < 18_000
              ? { ...dueRetry(30), version: 'x' }
              : { ...dueRetry(30), nextAttemptAt: iso(-60) };
      const started = performance.now();
      for (let from = 0; from < N; from += 2_000) {
        const range = Array.from({ length: 2_000 }, (_, k) => from + k);
        await prisma.job.createMany({
          data: range.map((i) => ({
            id: `scale-job-${i}`,
            companyId: company.id,
            externalId: `scale-${i}`,
            title: `Scale ${i}`,
            description: 'd',
            url: `https://jobs.example.com/scale/${i}`,
            country: 'IN',
            location: 'Bengaluru',
            postedAt: new Date(),
          })),
        });
        await prisma.jobMatch.createMany({
          data: range.map((i) => ({
            id: `scale-match-${i}`,
            userId: user.id,
            jobId: `scale-job-${i}`,
            resumeVersionId: version.id,
            overallScore: 80,
            technicalScore: 80,
            experienceScore: 80,
            opportunityScore: 90,
            verdict: 'APPLY',
            verdictCode: 'TARGET_ROLE_ELIGIBLE',
            verdictReason: 'Strong match',
            decidedAt: new Date(),
          })),
        });
        await prisma.notification.createMany({
          data: range.map((i) => ({
            userId: user.id,
            type: 'NEW_MATCHES' as const,
            payload: {
              matchId: `scale-match-${i}`,
              text: 'x'.repeat(900), // about the size of a real alert row
              delivery: deliveryOf(i),
            } as Prisma.InputJsonValue,
          })),
        });
      }
      const seededMs = performance.now() - started;
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const passStarted = performance.now();
      await expect(service.retryUndelivered()).resolves.toBe(20);
      const passMs = performance.now() - passStarted;

      expect(seen.map((q) => q.rows)).toEqual([75]);
      expect(telegram.sent).toHaveLength(20);
      console.log(
        `W2-SCALE: ${N} open alerts (seeded in ${Math.round(seededMs)} ms); ` +
          `the retry query returned ${seen[0].rows} rows in ${Math.round(seen[0].ms)} ms; ` +
          `the whole pass (20 sends, 50 settlements) took ${Math.round(passMs)} ms`,
      );
    },
    180_000,
  );
});
