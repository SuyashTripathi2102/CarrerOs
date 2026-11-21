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

/** No Telegram request may hang longer than this. */
export const TELEGRAM_TIMEOUT_MS = 15_000;

/**
 * Why a send did not succeed, in the terms that decide what happens next:
 *
 *   rejected      Telegram refused this message (400 and other 4xx). Sending it
 *                 again would be refused again.
 *   config        Telegram refused the bot or its chat, not this message: 401 (a
 *                 wrong or revoked token), 403 (the user blocked the bot, the bot
 *                 was removed from the chat, or it may not start the
 *                 conversation), 404 (a malformed token). CareerOS sends to
 *                 exactly one chat, TELEGRAM_CHAT_ID, so each of these refuses
 *                 every message that would follow: the whole channel is held,
 *                 deliberately, not just this alert.
 *   rate-limited  429; Telegram says when to try again.
 *   server        5xx; Telegram did not take the message.
 *   not-sent      the connection never opened (DNS, refused, unreachable), so the
 *                 message cannot have arrived.
 *   ambiguous     the request may have reached Telegram and its reply was lost
 *                 (timeout, connection reset, anything unrecognised). It may
 *                 have arrived.
 */
export type TelegramFailure =
  'rejected' | 'config' | 'rate-limited' | 'server' | 'not-sent' | 'ambiguous';

export class TelegramSendError extends Error {
  constructor(
    readonly failure: TelegramFailure,
    message: string,
    readonly status?: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'TelegramSendError';
  }
}

/** Raised before any byte of the request left this machine. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Classifies a non-2xx reply. The message carries Telegram's description, never the URL. */
export function classifyTelegramResponse(
  status: number,
  body: string,
): TelegramSendError {
  let description = body.slice(0, 200);
  let retryAfterSec: number | undefined;
  try {
    const parsed = JSON.parse(body) as {
      description?: unknown;
      parameters?: { retry_after?: unknown };
    };
    if (typeof parsed.description === 'string')
      description = parsed.description.slice(0, 200);
    if (typeof parsed.parameters?.retry_after === 'number')
      retryAfterSec = parsed.parameters.retry_after;
  } catch {
    // Not JSON: keep the raw text.
  }
  const message = `Telegram sendMessage -> ${status}: ${description}`;
  if (status === 429)
    return new TelegramSendError(
      'rate-limited',
      message,
      status,
      retryAfterSec ?? 60,
    );
  if (status === 401 || status === 403 || status === 404)
    return new TelegramSendError('config', message, status);
  if (status >= 400 && status < 500)
    return new TelegramSendError('rejected', message, status);
  if (status >= 500) return new TelegramSendError('server', message, status);
  return new TelegramSendError('ambiguous', message, status);
}

/** Classifies an error thrown by fetch itself, before any reply arrived. */
export function classifyFetchError(err: unknown): TelegramSendError {
  // Read by name, not instanceof: the DOMException a timeout raises need not
  // share this module's Error (a different realm, as under jest).
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new TelegramSendError(
      'ambiguous',
      `Telegram request timed out after ${TELEGRAM_TIMEOUT_MS} ms`,
    );
  }
  const cause = (err as { cause?: unknown })?.cause;
  const codes = errorCodes(cause);
  const detail = codes.length
    ? codes.join(', ')
    : err instanceof Error
      ? err.message
      : String(err);
  if (codes.length && codes.every((c) => NOT_SENT_CODES.has(c))) {
    return new TelegramSendError('not-sent', `Telegram not reached: ${detail}`);
  }
  return new TelegramSendError(
    'ambiguous',
    `Telegram request failed: ${detail}`,
  );
}

/** The error codes of a fetch failure; an AggregateError (one per address tried) gives all of them. */
function errorCodes(cause: unknown): string[] {
  if (!cause || typeof cause !== 'object') return [];
  const inner = (cause as { errors?: unknown }).errors;
  if (Array.isArray(inner) && inner.length)
    return inner.flatMap((e) => errorCodes(e));
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? [code] : [];
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
  /** Set once Telegram refuses the bot itself; held until the process restarts. */
  private refused: string | null = null;

  constructor(config: ConfigService) {
    this.token = config.get<string>('TELEGRAM_BOT_TOKEN') || undefined;
    this.chatId = config.get<string>('TELEGRAM_CHAT_ID') || undefined;
  }

  isConfigured(): boolean {
    return !!this.token && !!this.chatId;
  }

  /**
   * Why sends are held, or null. After a 401, 403 or 404 every further send
   * would be refused the same way, so none is attempted until a restart: one
   * that picks up a corrected TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID, or follows
   * unblocking the bot. Held alerts stay in-app and are sent after it.
   */
  heldReason(): string | null {
    return this.refused;
  }

  async send(text: string, opts?: SendOptions): Promise<void> {
    if (this.refused) {
      throw new TelegramSendError('config', `not sending: ${this.refused}`);
    }
    let res: Response;
    try {
      res = await fetch(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
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
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        },
      );
    } catch (err) {
      throw classifyFetchError(err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = classifyTelegramResponse(res.status, body);
      if (error.failure === 'config') {
        this.refused = `Telegram refused the bot configuration (${error.message}); fix TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID, or unblock the bot, then restart`;
        this.logger.error(
          `${this.refused}. Alerts are kept and sent after the restart.`,
        );
      }
      throw error;
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
      await fetch(
        `https://api.telegram.org/bot${this.token}/answerCallbackQuery`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: text.slice(0, 200),
          }),
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        },
      );
    } catch (err) {
      this.logger.warn(`answerCallbackQuery failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
