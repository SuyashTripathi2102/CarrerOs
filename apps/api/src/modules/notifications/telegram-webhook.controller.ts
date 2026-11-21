import { Body, Controller, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';
import { TelegramAppliedService } from './telegram-applied.service';
import {
  callbackSecretFor,
  extractCallback,
  planAppliedCallback,
  telegramInboundMode,
} from './telegram-callback';

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
 *
 * With TELEGRAM_INBOUND=polling the poller is the only inbound path, and this
 * endpoint acts on nothing.
 */
@Controller('telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    private readonly applied: TelegramAppliedService,
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
    if (
      telegramInboundMode(this.config.get<string>('TELEGRAM_INBOUND')) ===
      'polling'
    ) {
      this.logger.warn(
        'telegram webhook update ignored: TELEGRAM_INBOUND=polling',
      );
      return { ok: true };
    }

    const plan = planAppliedCallback(
      update,
      { secret },
      {
        webhookSecret: this.config.get<string>('TELEGRAM_WEBHOOK_SECRET'),
        chatId: this.config.get<string>('TELEGRAM_CHAT_ID'),
        callbackSecret: callbackSecretFor(
          this.config.get<string>('TELEGRAM_BOT_TOKEN'),
        ),
      },
    );
    await this.applied.act(plan, extractCallback(update)?.id ?? '', 'webhook');
    return { ok: true };
  }
}
