import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** One interface, many transports — Telegram now; email/Discord/push later. */
export interface NotificationChannel {
  readonly name: string;
  isConfigured(): boolean;
  send(text: string, opts?: SendOptions): Promise<void>;
}

/**
 * A URL button leaves Telegram; a callback button comes back to us.
 *
 * The callback variant is what closes the outcome loop: until it existed, every
 * notification was a one-way broadcast and CareerOS could not learn whether the
 * user acted. `callback_data` is capped at 64 bytes by Telegram — see
 * telegram-callback.ts for what we put in it and why it is not the job id.
 */
export type InlineButton =
  | { text: string; url: string }
  | { text: string; callback_data: string };

export interface SendOptions {
  /** Rows of buttons (Telegram inline keyboard). */
  buttons?: InlineButton[][];
}

/**
 * Telegram Bot API channel. Activates the moment TELEGRAM_BOT_TOKEN +
 * TELEGRAM_CHAT_ID appear in .env — no code change, no restart logic needed
 * beyond process restart. Get a token from @BotFather; get your chat id by
 * messaging the bot once and calling getUpdates.
 */
@Injectable()
export class TelegramChannel implements NotificationChannel {
  readonly name = 'telegram';
  private readonly logger = new Logger(TelegramChannel.name);
  private readonly token?: string;
  private readonly chatId?: string;

  constructor(config: ConfigService) {
    this.token = config.get<string>('TELEGRAM_BOT_TOKEN') || undefined;
    this.chatId = config.get<string>('TELEGRAM_CHAT_ID') || undefined;
  }

  isConfigured(): boolean {
    return !!this.token && !!this.chatId;
  }

  async send(text: string, opts?: SendOptions): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(opts?.buttons?.length
          ? { reply_markup: { inline_keyboard: opts.buttons } }
          : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Telegram sendMessage -> ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  /**
   * Close the loading spinner on a tapped inline button.
   *
   * Telegram requires this within seconds; without it the button spins and the
   * user reasonably concludes nothing happened. Best-effort by design — the
   * application is already recorded by the time this runs, and failing to
   * acknowledge must never undo that.
   */
  async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    if (!this.isConfigured() || !callbackQueryId) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text: text.slice(0, 200) }),
      });
    } catch (err) {
      this.logger.warn(`answerCallbackQuery failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
