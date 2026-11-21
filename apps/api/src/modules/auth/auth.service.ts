import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { UsersRepository } from '../users/users.repository';
import { RefreshTokensRepository } from './refresh-tokens.repository';
import type { AccessTokenPayload } from './strategies/jwt.strategy';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends TokenPair {
  user: { id: string; email: string; name: string | null; role: string };
}

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Says at every start whether the install has an administrator. The operator routes (crawls,
   * discovery, health, AI usage) admit only ADMIN accounts (W8); with accounts but no ADMIN they
   * refuse everyone until one is promoted, which the W8 migration does on deployment. A failed
   * count never stops the start.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const [admins, accounts] = await Promise.all([
        this.users.countAdmins(),
        this.users.count(),
      ]);
      if (accounts > 0 && admins === 0) {
        this.logger.warn(
          `no ADMIN among ${accounts} account(s): the operator routes refuse everyone until one is promoted`,
        );
      } else {
        this.logger.log(
          `authorization: ${admins} ADMIN of ${accounts} account(s)`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `could not count ADMIN accounts: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Sign-up is open only to create the first account, unless ALLOW_REGISTRATION=true.
   *
   * The decision is made under a lock, in the same transaction as the insert
   * (UsersRepository.createUnderSignupLock), so two sign-ups that arrive together can never both
   * create "the first account". The quick look at the count before it only spares a closed sign-up
   * the password hash; on its own it proves nothing. The gate is always checked before the email,
   * so a closed sign-up reveals nothing about which accounts exist.
   */
  async register(email: string, password: string, name?: string): Promise<AuthResult> {
    const openToAll = this.openToAll();
    if (!openToAll && (await this.users.count()) > 0)
      throw new ForbiddenException('Registration is closed');

    // Hashed before the lock is taken, so the lock is held only for the check and the insert.
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const outcome = await this.users.createUnderSignupLock(
      { email: email.toLowerCase(), passwordHash, name: name ?? null },
      openToAll,
    );
    if ('refused' in outcome) {
      if (outcome.refused === 'closed')
        throw new ForbiddenException('Registration is closed');
      throw new ConflictException('An account with this email already exists');
    }
    return this.buildAuthResult(outcome.created);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.users.findByEmail(email.toLowerCase());
    // Same error for wrong email and wrong password — no account enumeration.
    if (!user?.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return this.buildAuthResult(user);
  }

  /**
   * Verify current → rehash → revoke every session. Revoking all refresh
   * tokens is the point: a password change must lock out whoever else may
   * hold a session (the old password transited chat during the VPS deploy).
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user?.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    await this.users.updatePasswordHash(userId, await bcrypt.hash(newPassword, BCRYPT_ROUNDS));
    await this.refreshTokens.revokeAllForUser(userId);
  }

  /**
   * Rotation: every refresh consumes the presented token and issues a new pair.
   * Presenting an already-revoked token is treated as theft — all of that
   * user's sessions are revoked.
   */
  async refresh(rawToken: string): Promise<TokenPair> {
    const stored = await this.refreshTokens.findByHash(this.hashToken(rawToken));
    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    if (stored.revokedAt) {
      await this.refreshTokens.revokeAllForUser(stored.userId);
      throw new UnauthorizedException('Refresh token reuse detected — all sessions revoked');
    }
    if (stored.expiresAt < new Date()) throw new UnauthorizedException('Refresh token expired');

    const user = await this.users.findById(stored.userId);
    if (!user) throw new UnauthorizedException('Invalid refresh token');

    await this.refreshTokens.revoke(stored.id);
    return this.issueTokenPair(user);
  }

  async logout(rawToken: string): Promise<void> {
    const stored = await this.refreshTokens.findByHash(this.hashToken(rawToken));
    if (stored && !stored.revokedAt) await this.refreshTokens.revoke(stored.id);
    // Unknown token → still 204: logout must be idempotent.
  }

  /** ALLOW_REGISTRATION=true, in any case and with spaces around it: sign-up stays open to everyone. */
  private openToAll(): boolean {
    return (
      this.config.get<string>('ALLOW_REGISTRATION')?.trim().toLowerCase() ===
      'true'
    );
  }

  private async buildAuthResult(user: User): Promise<AuthResult> {
    const tokens = await this.issueTokenPair(user);
    return {
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }

  private async issueTokenPair(user: User): Promise<TokenPair> {
    const payload: AccessTokenPayload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = await this.jwt.signAsync(payload);

    const refreshToken = randomBytes(32).toString('hex');
    const ttlDays = this.config.get<number>('REFRESH_TOKEN_TTL_DAYS', 7);
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    await this.refreshTokens.create(user.id, this.hashToken(refreshToken), expiresAt);

    return { accessToken, refreshToken };
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
