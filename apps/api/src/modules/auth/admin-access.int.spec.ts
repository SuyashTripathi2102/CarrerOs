import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, Role } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { UsersRepository } from '../users/users.repository';
import { AuthService } from './auth.service';
import { RefreshTokensRepository } from './refresh-tokens.repository';

/**
 * W8 against a real Postgres: the first account is ADMIN and every later one USER, under real
 * concurrency, and the migration that promotes the live install's first account. The real
 * AuthService, UsersRepository and RefreshTokensRepository, with real bcrypt.
 *
 * Needs a THROWAWAY database, never a live one:
 *   W8_INT_DATABASE_URL  the current schema, no rows
 * Every test starts by truncating users, so the suite refuses to run, before any truncation, unless:
 *   - the database is named THROWAWAY_DB;
 *   - it is marked `ALTER DATABASE ... SET careeros.throwaway = 'w8'`;
 *   - it holds no user this suite did not create;
 *   - the URL is not the application's DATABASE_URL.
 * The first three are checked again inside the database, in the same statement as the TRUNCATE.
 * Without the variable the suite is skipped.
 *
 * Against W4 alone (before W8) every test here is expected to FAIL: accounts are created USER, and
 * the migration does not exist.
 */

const THROWAWAY_DB = 'w8_int';
const THROWAWAY_MARKER = 'w8';
const OWN_EMAIL = 'w8-%@example.test';
const MIGRATION = join(
  __dirname,
  '../../../prisma/migrations/20261113120000_w8_first_account_admin/migration.sql',
);

const GUARDED_TRUNCATE = `
DO $guard$
BEGIN
  IF current_database() <> '${THROWAWAY_DB}' THEN
    RAISE EXCEPTION 'refusing to truncate: database % is not ${THROWAWAY_DB}', current_database();
  END IF;
  IF current_setting('careeros.throwaway', true) IS DISTINCT FROM '${THROWAWAY_MARKER}' THEN
    RAISE EXCEPTION 'refusing to truncate: database % is not marked as the W8 throwaway', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE email NOT LIKE '${OWN_EMAIL}') THEN
    RAISE EXCEPTION 'refusing to truncate: database % holds users this suite did not create', current_database();
  END IF;
  TRUNCATE users RESTART IDENTITY CASCADE;
END
$guard$`;

const URL = process.env.W8_INT_DATABASE_URL;
const describeDb = URL ? describe : describe.skip;

describeDb('W8 against a real Postgres', () => {
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
        secret: 'w8-int-test',
        signOptions: { expiresIn: '15m' },
      }),
      config,
    );
  }
  const roles = async () =>
    (await prisma.user.findMany({ orderBy: { email: 'asc' } })).map(
      (u) => `${u.email}:${u.role}`,
    );
  const seed = (email: string, role: Role, createdAt: string) =>
    prisma.user.create({
      data: { email, passwordHash: 'x', role, createdAt: new Date(createdAt) },
    });
  const migrate = async () =>
    prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));

  beforeAll(async () => {
    if (URL === process.env.DATABASE_URL)
      throw new Error(
        'refusing to run: W8_INT_DATABASE_URL is the application database',
      );
    prisma = new PrismaClient({ datasourceUrl: URL });
    const [{ db, marker }] = await prisma.$queryRawUnsafe<
      { db: string; marker: string | null }[]
    >(
      "SELECT current_database() AS db, current_setting('careeros.throwaway', true) AS marker",
    );
    if (db !== THROWAWAY_DB || marker !== THROWAWAY_MARKER) {
      throw new Error(
        `refusing to run: ${db} is not the marked W8 throwaway (${THROWAWAY_DB}, ${THROWAWAY_MARKER})`,
      );
    }
  });
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(GUARDED_TRUNCATE);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  describe('sign-up', () => {
    it('creates the first account as ADMIN', async () => {
      await service().register('w8-owner@example.test', 'password123');

      expect(await roles()).toEqual(['w8-owner@example.test:ADMIN']);
    }, 30_000);

    it('with sign-up open to all, creates every later account as USER', async () => {
      const open = { ALLOW_REGISTRATION: 'true' };
      await service(open).register('w8-a-first@example.test', 'password123');
      await service(open).register('w8-b-second@example.test', 'password123');

      expect(await roles()).toEqual([
        'w8-a-first@example.test:ADMIN',
        'w8-b-second@example.test:USER',
      ]);
    }, 30_000);

    it('ten first sign-ups at the same moment: exactly one account, and it is ADMIN', async () => {
      await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          service().register(`w8-${i}@example.test`, 'password123'),
        ),
      );

      const all = await roles();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatch(/:ADMIN$/);
    }, 60_000);

    it('open to all, five sign-ups at the same moment on an empty table: exactly one ADMIN, four USER', async () => {
      const open = { ALLOW_REGISTRATION: 'true' };
      await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          service(open).register(`w8-open-${i}@example.test`, 'password123'),
        ),
      );

      const all = await roles();
      expect(all).toHaveLength(5);
      expect(all.filter((r) => r.endsWith(':ADMIN'))).toHaveLength(1);
      expect(all.filter((r) => r.endsWith(':USER'))).toHaveLength(4);
    }, 60_000);
  });

  describe('the promotion migration', () => {
    it('promotes the oldest account, and only that one, when there is no ADMIN', async () => {
      await seed('w8-newer@example.test', Role.USER, '2026-11-10T10:00:00Z');
      await seed('w8-oldest@example.test', Role.USER, '2026-11-01T10:00:00Z');
      await seed('w8-middle@example.test', Role.USER, '2026-11-05T10:00:00Z');

      await migrate();

      expect(await roles()).toEqual([
        'w8-middle@example.test:USER',
        'w8-newer@example.test:USER',
        'w8-oldest@example.test:ADMIN',
      ]);
    });

    it('changes nothing when an ADMIN already exists: no second ADMIN, no one demoted', async () => {
      await seed('w8-oldest@example.test', Role.USER, '2026-11-01T10:00:00Z');
      await seed('w8-admin@example.test', Role.ADMIN, '2026-11-05T10:00:00Z');

      await migrate();

      expect(await roles()).toEqual([
        'w8-admin@example.test:ADMIN',
        'w8-oldest@example.test:USER',
      ]);
    });

    it('changes nothing on an empty table', async () => {
      await migrate();

      expect(await roles()).toEqual([]);
    });

    it('is idempotent: run twice, it promotes once and the second run touches no row', async () => {
      await seed('w8-oldest@example.test', Role.USER, '2026-11-01T10:00:00Z');
      await seed('w8-newer@example.test', Role.USER, '2026-11-10T10:00:00Z');

      await migrate();
      const after1 = await prisma.user.findMany({ orderBy: { email: 'asc' } });
      await migrate();
      const after2 = await prisma.user.findMany({ orderBy: { email: 'asc' } });

      expect(after2.map((u) => `${u.email}:${u.role}`)).toEqual([
        'w8-newer@example.test:USER',
        'w8-oldest@example.test:ADMIN',
      ]);
      expect(after2.map((u) => u.updatedAt.getTime())).toEqual(
        after1.map((u) => u.updatedAt.getTime()),
      );
    });
  });
});
