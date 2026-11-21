import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import { AuthService } from './auth.service';
import type { RefreshTokensRepository } from './refresh-tokens.repository';
import type { UsersRepository } from '../users/users.repository';

type Locked = { created: User } | { refused: 'closed' | 'email-taken' };

/**
 * The sign-up gate with a fake users repository. Whether two sign-ups at once can both get through
 * is decided by Postgres, under the lock: register.int.spec.ts tests that against a real database.
 */
function setup(opts: {
  users: number;
  env?: Record<string, string>;
  locked?: Locked;
}) {
  const created: User = {
    id: 'u1',
    email: 'new@example.com',
    name: null,
    role: 'USER',
    passwordHash: 'hash',
  } as unknown as User;
  const users = {
    count: jest.fn().mockResolvedValue(opts.users),
    createUnderSignupLock: jest
      .fn()
      .mockResolvedValue(opts.locked ?? { created }),
  };
  const refreshTokens = { create: jest.fn().mockResolvedValue(undefined) };
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };
  const env = opts.env ?? {};
  const config = {
    get: (key: string, fallback?: unknown) => env[key] ?? fallback,
  };
  const service = new AuthService(
    users as unknown as UsersRepository,
    refreshTokens as unknown as RefreshTokensRepository,
    jwt as unknown as JwtService,
    config as unknown as ConfigService,
  );
  return { service, users };
}

describe('AuthService.register — sign-up gate', () => {
  it('refuses a new account once one exists, before hashing and without touching the lock or the email', async () => {
    const { service, users } = setup({ users: 1 });

    await expect(
      service.register('someone@example.com', 'password123'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(users.createUnderSignupLock).not.toHaveBeenCalled();
  });

  it('creates the very first account under the lock, so a fresh install can be set up', async () => {
    const { service, users } = setup({ users: 0 });

    const result = await service.register('First@Example.com', 'password123');

    expect(users.createUnderSignupLock).toHaveBeenCalledTimes(1);
    const [data, openToAll] = users.createUnderSignupLock.mock.calls[0] as [
      { email: string; passwordHash: string; name: string | null },
      boolean,
    ];
    expect(data.email).toBe('first@example.com');
    expect(data.passwordHash).toMatch(/^\$2[aby]\$12\$/); // hashed before the lock, never stored plain
    expect(data.name).toBeNull();
    expect(openToAll).toBe(false);
    expect(result.accessToken).toBe('access-token');
  });

  it('refuses when the decision under the lock says closed: another sign-up got there first', async () => {
    const { service } = setup({ users: 0, locked: { refused: 'closed' } });

    await expect(
      service.register('second@example.com', 'password123'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 409 when the email is already registered', async () => {
    const { service } = setup({ users: 0, locked: { refused: 'email-taken' } });

    await expect(
      service.register('taken@example.com', 'password123'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each(['true', 'TRUE', ' True ', '  true\t'])(
    'stays open to everyone when ALLOW_REGISTRATION=%p is set deliberately',
    async (value) => {
      const { service, users } = setup({
        users: 3,
        env: { ALLOW_REGISTRATION: value },
      });

      await service.register('another@example.com', 'password123');

      expect(users.count).not.toHaveBeenCalled();
      expect(users.createUnderSignupLock).toHaveBeenCalledWith(
        expect.anything(),
        true,
      );
    },
  );

  it.each(['false', 'yes', '1', '', 'true-ish', 'on'])(
    'treats ALLOW_REGISTRATION=%p as closed',
    async (value) => {
      const { service, users } = setup({
        users: 1,
        env: { ALLOW_REGISTRATION: value },
      });

      await expect(
        service.register('x@example.com', 'password123'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(users.createUnderSignupLock).not.toHaveBeenCalled();
    },
  );
});
