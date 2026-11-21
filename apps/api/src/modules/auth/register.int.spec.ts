import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { UsersRepository } from '../users/users.repository';
import { AuthService } from './auth.service';
import { RefreshTokensRepository } from './refresh-tokens.repository';

/**
 * Sign-up against a real Postgres: the first-account gate, the transaction-scoped advisory lock and
 * real concurrency. The real AuthService, UsersRepository and RefreshTokensRepository, with real
 * bcrypt; only the configuration is a stand-in.
 *
 * Needs a THROWAWAY database, never a live one:
 *   W4_INT_DATABASE_URL  the current schema, no rows
 * Every test starts by truncating users (and with them every row that belongs to a user), so the
 * suite refuses to run, before any truncation, unless all of these hold:
 *   - the database is named THROWAWAY_DB;
 *   - it is marked `ALTER DATABASE ... SET careeros.throwaway = 'w4'`;
 *   - it holds no user this suite did not create;
 *   - the URL is not the application's DATABASE_URL.
 * The first three are checked again inside the database, in the same statement as the TRUNCATE.
 * Without the variable the suite is skipped.
 *
 * W4_VARIANT=original runs the same file against W4 before the fix. There the three tests marked
 * "(race)" are expected to FAIL; that is the demonstration. The rest pass on both.
 */

const THROWAWAY_DB = 'w4_int';
const THROWAWAY_MARKER = 'w4';
const OWN_EMAIL = 'w4-%@example.test'; // LIKE: every user this suite creates

const GUARDED_TRUNCATE = `
DO $guard$
BEGIN
  IF current_database() <> '${THROWAWAY_DB}' THEN
    RAISE EXCEPTION 'refusing to truncate: database % is not ${THROWAWAY_DB}', current_database();
  END IF;
  IF current_setting('careeros.throwaway', true) IS DISTINCT FROM '${THROWAWAY_MARKER}' THEN
    RAISE EXCEPTION 'refusing to truncate: database % is not marked as the W4 throwaway', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE email NOT LIKE '${OWN_EMAIL}') THEN
    RAISE EXCEPTION 'refusing to truncate: database % holds users this suite did not create', current_database();
  END IF;
  TRUNCATE users RESTART IDENTITY CASCADE;
END
$guard$`;

const URL = process.env.W4_INT_DATABASE_URL;
const describeDb = URL ? describe : describe.skip;

describeDb('sign-up against a real Postgres', () => {
  let prisma: PrismaClient;

  function service(env: Record<string, string> = {}) {
    const db = prisma as unknown as PrismaService;
    const config = {
      get: (key: string, fallback?: unknown) => env[key] ?? fallback,
    } as unknown as ConfigService;
    return new AuthService(
      new UsersRepository(db),
      new RefreshTokensRepository(db),
      new JwtService({
        secret: 'w4-int-test',
        signOptions: { expiresIn: '15m' },
      }),
      config,
    );
  }
  const accounts = async () =>
    (await prisma.user.findMany({ orderBy: { email: 'asc' } })).map(
      (u) => u.email,
    );
  const statuses = (results: PromiseSettledResult<unknown>[]) => ({
    created: results.filter((r) => r.status === 'fulfilled').length,
    forbidden: results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ForbiddenException,
    ).length,
    conflict: results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ConflictException,
    ).length,
  });

  beforeAll(async () => {
    if (URL === process.env.DATABASE_URL)
      throw new Error(
        'refusing to run: W4_INT_DATABASE_URL is the application database',
      );
    prisma = new PrismaClient({ datasourceUrl: URL });
    const [{ db, marker }] = await prisma.$queryRawUnsafe<
      { db: string; marker: string | null }[]
    >(
      "SELECT current_database() AS db, current_setting('careeros.throwaway', true) AS marker",
    );
    if (db !== THROWAWAY_DB || marker !== THROWAWAY_MARKER) {
      throw new Error(
        `refusing to run: ${db} is not the marked W4 throwaway (${THROWAWAY_DB}, ${THROWAWAY_MARKER})`,
      );
    }
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(GUARDED_TRUNCATE);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('(race) two sign-ups at the same moment on an empty database: exactly one account', async () => {
    const results = await Promise.allSettled([
      service().register('w4-a@example.test', 'password123'),
      service().register('w4-b@example.test', 'password123'),
    ]);

    expect(statuses(results)).toEqual({
      created: 1,
      forbidden: 1,
      conflict: 0,
    });
    expect(await accounts()).toHaveLength(1);
  }, 30_000);

  it('(race) ten sign-ups at the same moment: exactly one account, nine refused', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        service().register(`w4-${i}@example.test`, 'password123'),
      ),
    );

    expect(statuses(results)).toEqual({
      created: 1,
      forbidden: 9,
      conflict: 0,
    });
    expect(await accounts()).toHaveLength(1);
  }, 60_000);

  it('(race) open to all, the same email twice at once: one account, one 409, nothing partial', async () => {
    const open = { ALLOW_REGISTRATION: 'true' };
    const results = await Promise.allSettled([
      service(open).register('w4-same@example.test', 'password123'),
      service(open).register('W4-Same@example.test', 'password123'),
    ]);

    expect(statuses(results)).toEqual({
      created: 1,
      forbidden: 0,
      conflict: 1,
    });
    expect(await accounts()).toEqual(['w4-same@example.test']);
  }, 30_000);

  it('open to all (ALLOW_REGISTRATION=true): five different sign-ups at once all get accounts', async () => {
    const open = { ALLOW_REGISTRATION: ' TRUE ' };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        service(open).register(`w4-open-${i}@example.test`, 'password123'),
      ),
    );

    expect(statuses(results)).toEqual({
      created: 5,
      forbidden: 0,
      conflict: 0,
    });
    expect(await accounts()).toHaveLength(5);
  }, 30_000);

  it('an existing account closes sign-up, for sign-ups arriving together too', async () => {
    await prisma.user.create({
      data: { email: 'w4-owner@example.test', passwordHash: 'x' },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, (_, i) =>
        service().register(`w4-late-${i}@example.test`, 'password123'),
      ),
    );

    expect(statuses(results)).toEqual({
      created: 0,
      forbidden: 3,
      conflict: 0,
    });
    expect(await accounts()).toEqual(['w4-owner@example.test']);
  }, 30_000);

  it('a sign-up that fails inside the transaction leaves no account behind, and the next one succeeds', async () => {
    // Postgres refuses a NUL character in text: the insert fails, so the transaction rolls back.
    await expect(
      service().register(
        'w4-broken@example.test',
        'password123',
        'bad\u0000name',
      ),
    ).rejects.toThrow();
    expect(await accounts()).toEqual([]);

    await service().register('w4-first@example.test', 'password123');
    expect(await accounts()).toEqual(['w4-first@example.test']);
  }, 30_000);
});
