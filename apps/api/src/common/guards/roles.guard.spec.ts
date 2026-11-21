import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

/** A guard over a fake users table: `roles` is what the database says each account is now. */
function setup(roles: Record<string, Role>) {
  const findUnique = jest.fn(({ where }: { where: { id: string } }) =>
    Promise.resolve(where.id in roles ? { role: roles[where.id] } : null),
  );
  const prisma = { user: { findUnique } } as unknown as PrismaService;
  return { guard: new RolesGuard(new Reflector(), prisma), findUnique };
}

/** An HTTP request to a handler marked with `required` roles (none when undefined), as `user`. */
function context(
  required: Role[] | undefined,
  user?: { id: string; role: Role },
): ExecutionContext {
  const handler = () => undefined;
  if (required) Reflect.defineMetadata(ROLES_KEY, required, handler);
  return {
    getHandler: () => handler,
    getClass: () => class Plain {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard: the current role, from the database', () => {
  it('lets a route without @Roles through, without a query', async () => {
    const { guard, findUnique } = setup({});

    await expect(
      guard.canActivate(context(undefined, { id: 'u1', role: Role.USER })),
    ).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('admits an account the database says is ADMIN', async () => {
    const { guard } = setup({ a1: Role.ADMIN });

    await expect(
      guard.canActivate(context([Role.ADMIN], { id: 'a1', role: Role.ADMIN })),
    ).resolves.toBe(true);
  });

  it('refuses a USER', async () => {
    const { guard } = setup({ u1: Role.USER });

    await expect(
      guard.canActivate(context([Role.ADMIN], { id: 'u1', role: Role.USER })),
    ).resolves.toBe(false);
  });

  it('refuses at once an account demoted since its token was issued (the token still says ADMIN)', async () => {
    const { guard } = setup({ a1: Role.USER });

    await expect(
      guard.canActivate(context([Role.ADMIN], { id: 'a1', role: Role.ADMIN })),
    ).resolves.toBe(false);
  });

  it('admits at once an account promoted since its token was issued (the token still says USER)', async () => {
    const { guard } = setup({ u1: Role.ADMIN });

    await expect(
      guard.canActivate(context([Role.ADMIN], { id: 'u1', role: Role.USER })),
    ).resolves.toBe(true);
  });

  it('refuses an account that no longer exists', async () => {
    const { guard } = setup({});

    await expect(
      guard.canActivate(
        context([Role.ADMIN], { id: 'gone', role: Role.ADMIN }),
      ),
    ).resolves.toBe(false);
  });

  it('refuses a request with no signed-in account, without a query', async () => {
    const { guard, findUnique } = setup({ a1: Role.ADMIN });

    await expect(guard.canActivate(context([Role.ADMIN]))).resolves.toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
