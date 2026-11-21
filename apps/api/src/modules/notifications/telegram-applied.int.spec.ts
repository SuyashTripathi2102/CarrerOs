import { writeFileSync } from 'node:fs';
import { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ApplicationsService } from '../applications/applications.service';
import {
  APPLIED_REPLIES,
  isDuplicateApplication,
  TelegramAppliedService,
} from './telegram-applied.service';

/**
 * The "✓ Applied" writer against a real Postgres, with the real ApplicationsService: one tap,
 * a repeat, ten taps at once, a job that is gone, and the P2002 that Postgres and Prisma really
 * produce for the (userId, jobId) key and for another key.
 *
 * Needs a THROWAWAY database, never a live one:
 *   W6_INT_DATABASE_URL  the current schema, no rows
 * Every test starts by truncating users and companies (cascading to jobs, notifications and
 * applications), so the suite refuses to run, before any truncation, unless:
 *   - the database is named THROWAWAY_DB;
 *   - it is marked `ALTER DATABASE ... SET careeros.throwaway = 'w6'`;
 *   - it holds no user and no company this suite did not create;
 *   - the URL is not the application's DATABASE_URL.
 * The first three are checked again inside the database, in the same statement as the TRUNCATE.
 * Without the variable the suite is skipped. W6_INT_META_OUT, when set, receives the `meta` of
 * the real P2002, so the run's summary can show what Prisma reported.
 */

const THROWAWAY_DB = 'w6_int';
const THROWAWAY_MARKER = 'w6';
const OWN_EMAIL = 'w6-%@example.test';
const OWN_COMPANY = 'w6-%';

const GUARDED_TRUNCATE = `
DO $guard$
BEGIN
  IF current_database() <> '${THROWAWAY_DB}' THEN
    RAISE EXCEPTION 'refusing to truncate: database % is not ${THROWAWAY_DB}', current_database();
  END IF;
  IF current_setting('careeros.throwaway', true) IS DISTINCT FROM '${THROWAWAY_MARKER}' THEN
    RAISE EXCEPTION 'refusing to truncate: database % is not marked as the W6 throwaway', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE email NOT LIKE '${OWN_EMAIL}')
     OR EXISTS (SELECT 1 FROM companies WHERE name NOT LIKE '${OWN_COMPANY}') THEN
    RAISE EXCEPTION 'refusing to truncate: database % holds rows this suite did not create', current_database();
  END IF;
  TRUNCATE users, companies RESTART IDENTITY CASCADE;
END
$guard$`;

const URL = process.env.W6_INT_DATABASE_URL;
const describeDb = URL ? describe : describe.skip;

describeDb('the Applied writer against a real Postgres (W6 fix)', () => {
  let prisma: PrismaClient;
  let answered: string[];

  function writer(client: PrismaClient = prisma) {
    const db = client as unknown as PrismaService;
    const telegram = {
      answerCallback: (_id: string, text: string) => {
        answered.push(text);
        return Promise.resolve();
      },
    };
    return new TelegramAppliedService(
      db,
      new ApplicationsService(db, new AnalyticsService(db)),
      telegram as never,
    );
  }

  /** One user, one company, one job, and the alert that surfaced the job. */
  async function seed(jobId?: string) {
    const user = await prisma.user.create({
      data: { email: 'w6-owner@example.test', passwordHash: 'x' },
    });
    const company = await prisma.company.create({ data: { name: 'w6-acme' } });
    const job = await prisma.job.create({
      data: {
        companyId: company.id,
        externalId: 'w6-job-1',
        title: 'Backend Engineer',
        description: 'Node.js',
        url: 'https://example.test/jobs/1',
      },
    });
    const notification = await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'NEW_MATCHES',
        payload: { jobId: jobId ?? job.id },
      },
    });
    return { user, job, notification };
  }
  const tap = (notificationId: string) =>
    ({ action: 'RECORD', notificationId }) as const;

  beforeAll(async () => {
    if (URL === process.env.DATABASE_URL) {
      throw new Error(
        'refusing to run: W6_INT_DATABASE_URL is the application database',
      );
    }
    prisma = new PrismaClient({ datasourceUrl: URL });
    const [{ db, marker }] = await prisma.$queryRawUnsafe<
      { db: string; marker: string | null }[]
    >(
      "SELECT current_database() AS db, current_setting('careeros.throwaway', true) AS marker",
    );
    if (db !== THROWAWAY_DB || marker !== THROWAWAY_MARKER) {
      throw new Error(
        `refusing to run: ${db} is not the marked W6 throwaway (${THROWAWAY_DB}, ${THROWAWAY_MARKER})`,
      );
    }
  });
  beforeEach(async () => {
    answered = [];
    await prisma.$executeRawUnsafe(GUARDED_TRUNCATE);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('records a tap once, as APPLIED from telegram, and a repeat tap is "Already recorded"', async () => {
    const { user, job, notification } = await seed();

    await writer().act(tap(notification.id), 'cb-1', 'polling');
    await writer().act(tap(notification.id), 'cb-2', 'polling');

    const rows = await prisma.application.findMany({
      where: { userId: user.id, jobId: job.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'APPLIED', source: 'telegram' });
    expect(answered).toEqual([
      APPLIED_REPLIES.recorded,
      APPLIED_REPLIES.alreadyRecorded,
    ]);
  }, 30_000);

  it('ten taps at the same moment: exactly one application, and no tap is told it failed', async () => {
    const { user, job, notification } = await seed();

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writer().act(tap(notification.id), `cb-${i}`, 'polling'),
      ),
    );

    expect(
      await prisma.application.count({
        where: { userId: user.id, jobId: job.id },
      }),
    ).toBe(1);
    expect(answered).toHaveLength(10);
    expect(
      answered.filter((a) => a === APPLIED_REPLIES.recorded).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      answered.every(
        (a) =>
          a === APPLIED_REPLIES.recorded ||
          a === APPLIED_REPLIES.alreadyRecorded,
      ),
    ).toBe(true);
  }, 60_000);

  it('the P2002 Postgres raises for a second application on (userId, jobId) is recognised as a duplicate', async () => {
    const { user, job } = await seed();
    await prisma.application.create({
      data: { userId: user.id, jobId: job.id },
    });

    const err = await prisma.application
      .create({ data: { userId: user.id, jobId: job.id } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    if (process.env.W6_INT_META_OUT) {
      writeFileSync(
        process.env.W6_INT_META_OUT,
        JSON.stringify((err as Prisma.PrismaClientKnownRequestError).meta),
      );
    }
    expect(isDuplicateApplication(err)).toBe(true);
  }, 30_000);

  it('a P2002 on another key (a second user with the same email) is not a duplicate application', async () => {
    await seed();

    const err = await prisma.user
      .create({ data: { email: 'w6-owner@example.test', passwordHash: 'x' } })
      .catch((e: unknown) => e);

    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect(isDuplicateApplication(err)).toBe(false);
  }, 30_000);

  it('a tap for a job that no longer exists says so and records nothing', async () => {
    const { user, notification } = await seed('w6-job-that-is-gone');

    await writer().act(tap(notification.id), 'cb-1', 'polling');

    expect(await prisma.application.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(answered).toEqual([APPLIED_REPLIES.jobGone]);
  }, 30_000);

  it('a database that cannot be reached: the tap is answered "please tap again", and act() does not throw', async () => {
    const unreachable = new PrismaClient({
      datasourceUrl: 'postgresql://w6@127.0.0.1:1/w6_int',
    });
    try {
      await expect(
        writer(unreachable).act(tap('any-notification'), 'cb-1', 'polling'),
      ).resolves.toBeUndefined();
      expect(answered).toEqual([APPLIED_REPLIES.failed]);
    } finally {
      await unreachable.$disconnect();
    }
  }, 30_000);
});
