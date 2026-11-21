import { Injectable } from '@nestjs/common';
import { Prisma, Role, User, UserPreference } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  count(): Promise<number> {
    return this.prisma.user.count();
  }

  countAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { role: Role.ADMIN } });
  }

  create(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({ data });
  }

  /**
   * Creates an account under the sign-up lock. One transaction takes a transaction-scoped advisory
   * lock, then checks the gate and the email, then inserts: two sign-ups can never both see "no
   * account yet", and nothing is left behind if any step fails (the transaction rolls back, and the
   * lock is released with it).
   *
   * Every sign-up goes through here, open or closed, so all of them queue on the same lock. The
   * gate is checked before the email, so a closed sign-up still says nothing about who is
   * registered. `openToAll` is ALLOW_REGISTRATION=true: then only the email is checked.
   *
   * The first account is created ADMIN: it administers the install (W8). Every later account, which
   * only ALLOW_REGISTRATION=true allows, is USER. Decided under the lock, so a fresh install gets
   * exactly one ADMIN however many sign-ups arrive together.
   */
  createUnderSignupLock(
    data: Prisma.UserCreateInput,
    openToAll: boolean,
  ): Promise<{ created: User } | { refused: 'closed' | 'email-taken' }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('careeros-signup', 0))`;
      const accounts = await tx.user.count();
      if (!openToAll && accounts > 0) return { refused: 'closed' as const };
      if (await tx.user.findUnique({ where: { email: data.email } }))
        return { refused: 'email-taken' as const };
      const role = accounts === 0 ? Role.ADMIN : Role.USER;
      return { created: await tx.user.create({ data: { ...data, role } }) };
    });
  }

  updatePasswordHash(id: string, passwordHash: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }

  getPreference(userId: string): Promise<UserPreference | null> {
    return this.prisma.userPreference.findUnique({ where: { userId } });
  }

  upsertPreference(
    userId: string,
    data: Omit<Prisma.UserPreferenceUncheckedCreateInput, 'userId' | 'id'>,
  ): Promise<UserPreference> {
    return this.prisma.userPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }
}
