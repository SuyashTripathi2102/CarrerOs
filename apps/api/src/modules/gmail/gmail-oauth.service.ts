import { Injectable, Logger } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { GmailConnectionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptToken, decryptToken, redactToken } from './gmail-crypto';

/**
 * Gmail OAuth 2.0 — consent, code exchange, and access-token refresh.
 *
 * READ-ONLY BY CONSTRUCTION. The only scope requested is `gmail.readonly`, so
 * "this connector cannot send, label, modify or delete mail" is a property of
 * the grant Google enforces, not a promise made in a code review. Widening this
 * array is a security decision, not a convenience.
 */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'] as const;

/**
 * Google signals a dead grant with `invalid_grant`. It means the user revoked
 * access, changed their password, or the token aged out — none of which retrying
 * can fix.
 *
 * Distinguishing it from a transient failure matters: a transient error should
 * back off and retry, while a dead grant must stop polling and say so. Treating
 * the second as the first produces a connector that looks busy forever and
 * silently returns no mail.
 */
export function isDeadGrant(err: unknown): boolean {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  const code = e?.response?.data?.error ?? '';
  if (code === 'invalid_grant' || code === 'invalid_client') return true;
  return /invalid_grant|invalid_client|token has been (expired|revoked)/i.test(e?.message ?? '');
}

@Injectable()
export class GmailOAuthService {
  private readonly logger = new Logger(GmailOAuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  private client(): OAuth2Client {
    const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirect = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    if (!id || !secret || !redirect) {
      throw new Error(
        'GOOGLE_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI must all be set',
      );
    }
    return new OAuth2Client({ clientId: id, clientSecret: secret, redirectUri: redirect });
  }

  /**
   * The URL the user visits to grant access.
   *
   * `access_type: 'offline'` + `prompt: 'consent'` are both required to be
   * handed a refresh token. Without them Google returns only an access token on
   * repeat authorisations, and the connection would work for one hour and then
   * be permanently unusable — with nothing in the flow reporting a problem.
   */
  consentUrl(state: string): string {
    return this.client().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...GMAIL_SCOPES],
      include_granted_scopes: false,
      state,
    });
  }

  /** Exchange the authorization code and persist the connection. */
  async exchangeCode(
    userId: string,
    code: string,
  ): Promise<{ connectionId: string; emailAddress: string }> {
    const client = this.client();
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      // Storing a connection without one produces a row that reads ACTIVE and
      // can never sync — a silent dead end.
      throw new Error(
        'Google returned no refresh_token. The grant must use access_type=offline ' +
          'and prompt=consent; re-authorise rather than storing this connection.',
      );
    }

    client.setCredentials(tokens);
    const info = await client.getTokenInfo(tokens.access_token as string);
    const emailAddress = info.email;
    if (!emailAddress) throw new Error('Google did not return an email address for this grant');

    const row = await this.prisma.gmailConnection.upsert({
      where: { userId_emailAddress: { userId, emailAddress } },
      create: {
        userId,
        emailAddress,
        refreshTokenEnc: encryptToken(tokens.refresh_token),
        scope: GMAIL_SCOPES.join(' '),
        status: GmailConnectionStatus.ACTIVE,
      },
      update: {
        // Re-consent replaces the token and clears any prior dead state, but
        // deliberately leaves historyId alone so a reconnect resumes rather
        // than re-reading the mailbox.
        refreshTokenEnc: encryptToken(tokens.refresh_token),
        scope: GMAIL_SCOPES.join(' '),
        status: GmailConnectionStatus.ACTIVE,
      },
      select: { id: true },
    });

    this.logger.log(
      `[gmail] connected ${emailAddress} (refresh token ${redactToken(tokens.refresh_token)})`,
    );
    return { connectionId: row.id, emailAddress };
  }

  /**
   * A live access token for a stored connection.
   *
   * Access tokens are never persisted — they are derived here and discarded, so
   * the database holds exactly one long-lived secret.
   */
  async accessTokenFor(connectionId: string): Promise<string> {
    const conn = await this.prisma.gmailConnection.findUniqueOrThrow({
      where: { id: connectionId },
      select: { id: true, emailAddress: true, refreshTokenEnc: true, status: true },
    });
    if (conn.status !== GmailConnectionStatus.ACTIVE) {
      throw new Error(`gmail connection ${conn.emailAddress} is ${conn.status}, not ACTIVE`);
    }

    const client = this.client();
    client.setCredentials({ refresh_token: decryptToken(conn.refreshTokenEnc) });

    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new Error('Google returned an empty access token');
      return token;
    } catch (err) {
      if (isDeadGrant(err)) {
        // Stop polling and SAY SO. The alternative — retrying forever — reads
        // as a healthy connector with an empty inbox.
        await this.prisma.gmailConnection.update({
          where: { id: conn.id },
          data: { status: GmailConnectionStatus.NEEDS_RECONSENT },
        });
        this.logger.warn(
          `[gmail] grant for ${conn.emailAddress} is dead — marked NEEDS_RECONSENT, polling stopped`,
        );
      }
      throw err;
    }
  }
}
