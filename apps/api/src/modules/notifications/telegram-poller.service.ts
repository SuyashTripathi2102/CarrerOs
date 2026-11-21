import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramChannel } from './channels';
import { TelegramAppliedService } from './telegram-applied.service';
import {
  callbackSecretFor,
  extractCallback,
  planPolledCallback,
  telegramInboundMode,
} from './telegram-callback';

const LONG_POLL_SECONDS = 25;
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const CONFLICT_BACKOFF_MS = 30_000;
/**
 * Telegram refusing the bot itself: a revoked or wrong token (401, 404) or a forbidden bot (403).
 * Retrying cannot fix these, so polling stops, as W2's channel holds sending on the same statuses.
 */
const PERMANENT_STATUSES = new Set([401, 403, 404]);

interface TelegramUpdate {
  update_id: number;
}

/** Carries Telegram's own description, never the request URL (the token is in it). */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    description?: string,
  ) {
    super(
      `${method} -> ${status}${description ? `: ${description.slice(0, 160)}` : ''}`,
    );
    this.name = 'TelegramApiError';
  }
}

/**
 * "✓ Applied" taps without a public URL: CareerOS asks Telegram for them with
 * getUpdates long polling, instead of Telegram pushing to the webhook.
 *
 * ONE CONSUMER. Telegram gives a bot either a webhook or getUpdates, never both,
 * and two getUpdates callers cut each other off with 409. So this runs only with
 * TELEGRAM_INBOUND=polling, refuses to start while a webhook is registered (it
 * never deletes one), and backs off on 409. Run one API process in this mode. A
 * second one cannot double-record — Telegram hands each update to a single
 * caller and recording is idempotent — it only produces 409s.
 */
@Injectable()
export class TelegramPollerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramPollerService.name);
  private offset: number | undefined;
  private stopped = false;
  private inFlight?: AbortController;
  private wake?: () => void;
  private loop?: Promise<void>;

  constructor(
    private readonly applied: TelegramAppliedService,
    private readonly telegram: TelegramChannel,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (
      telegramInboundMode(this.config.get<string>('TELEGRAM_INBOUND')) !==
      'polling'
    )
      return;
    if (!this.telegram.isConfigured()) {
      this.logger.warn(
        'TELEGRAM_INBOUND=polling but Telegram is not configured; not polling',
      );
      return;
    }
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.inFlight?.abort();
    this.wake?.();
    await this.loop?.catch(() => undefined);
  }

  /** False while a webhook is registered: polling then would fail with 409, or steal its updates. */
  async canPoll(): Promise<boolean> {
    const info = await this.call<{ url?: string }>('getWebhookInfo', {});
    return !info.url;
  }

  /**
   * One long-poll round. The offset moves past each update BEFORE it is acted
   * on, so an update that throws is not re-delivered forever; the user can tap
   * again, and a re-delivery after a crash is harmless because recording is
   * idempotent.
   */
  async pollOnce(): Promise<number> {
    const updates = await this.call<TelegramUpdate[]>('getUpdates', {
      ...(this.offset !== undefined ? { offset: this.offset } : {}),
      timeout: LONG_POLL_SECONDS,
      allowed_updates: ['callback_query'],
    });
    const configured = {
      chatId: this.config.get<string>('TELEGRAM_CHAT_ID'),
      callbackSecret: callbackSecretFor(
        this.config.get<string>('TELEGRAM_BOT_TOKEN'),
      ),
    };
    for (const update of updates) {
      this.offset = update.update_id + 1;
      try {
        const plan = planPolledCallback(update, configured);
        await this.applied.act(
          plan,
          extractCallback(update)?.id ?? '',
          'polling',
        );
      } catch (err) {
        this.logger.error(
          `telegram update ${update.update_id} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return updates.length;
  }

  private async run(): Promise<void> {
    let checked = false;
    let backoff = MIN_BACKOFF_MS;
    this.logger.log(
      'Telegram inbound: polling getUpdates (no webhook, no public URL)',
    );
    while (!this.stopped) {
      try {
        if (!checked) {
          if (!(await this.canPoll())) {
            this.logger.error(
              'a Telegram webhook is registered, so polling would conflict with it; not polling. ' +
                'Remove the webhook, or set TELEGRAM_INBOUND=webhook.',
            );
            return;
          }
          checked = true;
        }
        await this.pollOnce();
        backoff = MIN_BACKOFF_MS;
      } catch (err) {
        if (this.stopped) return;
        if (
          err instanceof TelegramApiError &&
          PERMANENT_STATUSES.has(err.status)
        ) {
          this.logger.error(
            `Telegram refused the bot (${err.message}); polling stopped. ` +
              'Check TELEGRAM_BOT_TOKEN, then restart the API.',
          );
          return;
        }
        const conflict = err instanceof TelegramApiError && err.status === 409;
        const wait = conflict ? CONFLICT_BACKOFF_MS : backoff;
        this.logger.warn(
          `telegram ${conflict ? 'polling conflict (another consumer or a webhook)' : 'polling failed'}: ` +
            `${describe(err)}; retrying in ${Math.round(wait / 1000)}s`,
        );
        if (conflict) checked = false;
        await this.sleep(wait);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    this.inFlight = controller;
    const timer = setTimeout(
      () => controller.abort(),
      (LONG_POLL_SECONDS + 10) * 1000,
    );
    try {
      const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
      const res = await fetch(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: T;
        description?: string;
      } | null;
      if (!res.ok || !json?.ok)
        throw new TelegramApiError(method, res.status, json?.description);
      return json.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends early on shutdown, so a back-off never holds the process open. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

/** Error name and code only: a fetch error's message can include the request URL. */
function describe(err: unknown): string {
  if (err instanceof TelegramApiError) return err.message;
  const e = err as { name?: string; cause?: { code?: string } } | null;
  return [e?.name ?? 'Error', e?.cause?.code].filter(Boolean).join(' ');
}
