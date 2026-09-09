import { Body, Controller, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplicationStatus } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplicationsService } from '../applications/applications.service';
import { TelegramChannel } from './channels';
import { extractCallback, planAppliedCallback } from './telegram-callback';

/**
 * Inbound Telegram updates — the one signal CareerOS gets back from the user.
 *
 * SECURITY. This is an unauthenticated-by-JWT endpoint that writes to the
 * database, so it defends itself three ways, and all three must pass before
 * anything is written:
 *
 *   1. the secret header Telegram echoes from setWebhook (constant-time)
 *   2. the sender's chat id must be the configured one
 *   3. the callback data must carry our HMAC signature
 *
 * And the payload is never authority. It names a NOTIFICATION we wrote; the
 * user and the job come from that row, so a caller cannot record an application
 * against an arbitrary job even if it defeats all three checks.
 *
 * It always answers 200. Telegram retries non-2xx, and a retry loop on an
 * update we have deliberately ignored is worse than the ignored update.
 */
@Controller('telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly applications: ApplicationsService,
    private readonly telegram: TelegramChannel,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('webhook')
  // Nest defaults POST to 201. Telegram's API documents 200 as the expected
  // acknowledgement, and while it accepts any 2xx there is no reason to differ
  // from the contract on the one endpoint it calls.
  @HttpCode(200)
  async webhook(
    @Body() update: unknown,
    @Headers('x-telegram-bot-api-secret-token') secret?: string,
  ): Promise<{ ok: true }> {
    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    const plan = planAppliedCallback(
      update,
      { secret },
      {
        webhookSecret: this.config.get<string>('TELEGRAM_WEBHOOK_SECRET'),
        chatId: this.config.get<string>('TELEGRAM_CHAT_ID'),
        callbackSecret: botToken ? `careeros-callback:${botToken}` : undefined,
      },
    );

    if (plan.action === 'IGNORE') {
      // Logged, never actioned. A rejected update that writes nothing is the
      // whole point of this branch.
      this.logger.warn(`telegram callback ignored: ${plan.reason}`);
      return { ok: true };
    }

    const callbackId = extractCallback(update)?.id ?? '';
    const message = await this.recordApplied(plan.notificationId);
    await this.telegram.answerCallback(callbackId, message);
    return { ok: true };
  }

  /**
   * Resolve the notification, then record the application through the EXISTING
   * path — ApplicationsService.createFromJob already writes the application, its
   * status event, the resume version that applied, and the APPLIED analytics
   * event. Duplicating any of that here would create a second source of truth
   * for the outcome data this loop exists to collect.
   *
   * IDEMPOTENT. Telegram retries on timeout and a user can tap twice, so the
   * second call must be a no-op rather than an error or a duplicate row.
   */
  private async recordApplied(notificationId: string): Promise<string> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { userId: true, payload: true },
    });
    if (!notification) {
      this.logger.warn(`telegram callback: notification ${notificationId} not found`);
      return 'That notification has expired.';
    }

    const payload = notification.payload as { jobId?: unknown } | null;
    const jobId = typeof payload?.jobId === 'string' ? payload.jobId : null;
    if (!jobId) {
      this.logger.warn(`telegram callback: notification ${notificationId} carries no jobId`);
      return 'Could not identify the job.';
    }

    // The click means "I applied to the job you showed me", so the verdict is
    // not re-checked here — it was APPLY when we sent it, and a later
    // re-decision must not make an application the user really made
    // unrecordable. What IS checked is that the job was actually surfaced to
    // this user, which the notification row establishes.
    const existing = await this.prisma.application.findUnique({
      where: { userId_jobId: { userId: notification.userId, jobId } },
      select: { id: true, status: true },
    });
    if (existing) {
      return existing.status === ApplicationStatus.APPLIED
        ? 'Already recorded as applied.'
        : `Already tracked (${existing.status.toLowerCase()}).`;
    }

    try {
      await this.applications.createFromJob(notification.userId, jobId, {
        status: ApplicationStatus.APPLIED,
        source: 'telegram',
      });
      return '✅ Recorded as applied.';
    } catch (err) {
      // A race between two taps lands here: the unique (userId, jobId) rejects
      // the second insert. That is the idempotency guarantee holding, not a
      // failure worth showing the user as one.
      this.logger.warn(
        `telegram applied for job ${jobId}: ${err instanceof Error ? err.message : err}`,
      );
      return 'Already recorded as applied.';
    }
  }
}
