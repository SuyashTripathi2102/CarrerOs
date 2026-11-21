import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Routes marked @Roles(...) admit only accounts whose CURRENT role, read from the database on every
 * such request, is one of those roles. The role inside the access token is not trusted here: it is
 * as old as the token (up to 15 minutes), so a demoted account would keep its access until the
 * token expired, and a promoted one would wait for a refresh. An account that no longer exists is
 * refused. Routes without @Roles are not affected and cost no query.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user?.id) return false;
    const current = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { role: true },
    });
    return !!current && required.includes(current.role);
  }
}
