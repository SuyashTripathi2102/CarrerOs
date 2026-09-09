import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Inbound Telegram callback handling — the decision logic, separated from the
 * HTTP and the database so it can be tested without either.
 *
 * WHY THIS EXISTS (audited 2026-09-09). CareerOS decides ~2-4 new APPLY
 * opportunities a day and notifies the user about essentially all of them (104
 * of 107 all-time). After that it learns nothing: the Telegram message carries
 * a raw employer URL, there is no inbound path, and `applications` has never
 * held a row. `applied_total = 0` was therefore not a measurement of behaviour
 * — no mechanism existed by which an application could be recorded at all.
 *
 * This closes that loop with the smallest possible surface: one button, one
 * callback, one existing write path.
 *
 * THE TOKEN. Telegram allows 64 bytes of callback_data, so it cannot carry the
 * job. It carries the NOTIFICATION id — a record CareerOS already wrote, which
 * resolves server-side to both the user and the job. Nothing in the payload is
 * treated as authority: the notification is looked up, its owner is the user,
 * and its job is the job. A caller cannot name an arbitrary job.
 *
 * It is signed anyway. The webhook authenticates the sender, so forgery is
 * already hard, but a signature means a malformed or replayed update cannot
 * reach the database at all — and the secret is derived from the bot token that
 * must already be configured, so this adds no new setup step.
 */

export const APPLIED_PREFIX = 'a';
const SIG_LEN = 10;

/** Telegram's hard limit on callback_data. Exceeding it fails at send time. */
export const CALLBACK_DATA_MAX_BYTES = 64;

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex').slice(0, SIG_LEN);
}

/** `a:<notificationId>:<sig>` — compact, opaque, and stable for the life of the row. */
export function encodeAppliedToken(notificationId: string, secret: string): string {
  if (!notificationId) throw new Error('notificationId required');
  if (!secret) throw new Error('callback secret required');
  const body = `${APPLIED_PREFIX}:${notificationId}`;
  const token = `${body}:${signature(body, secret)}`;
  if (Buffer.byteLength(token, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`callback_data ${Buffer.byteLength(token, 'utf8')} bytes exceeds Telegram's ${CALLBACK_DATA_MAX_BYTES}`);
  }
  return token;
}

/**
 * Returns the notification id only when the token is well-formed AND signed by
 * us. Every other input — truncated, tampered, from another bot, random — is
 * null, and a null must not reach the database.
 */
export function decodeAppliedToken(token: string | undefined, secret: string): string | null {
  if (!token || !secret) return null;
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  const [prefix, notificationId, sig] = parts;
  if (prefix !== APPLIED_PREFIX || !notificationId || !sig) return null;

  const expected = signature(`${prefix}:${notificationId}`, secret);
  // Constant-time: a length check first, because timingSafeEqual throws on a
  // length mismatch and that throw would itself be an oracle.
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return notificationId;
}

/**
 * Is this update one we are willing to act on?
 *
 * Telegram will happily deliver updates from anyone who finds the webhook URL,
 * and this endpoint writes to the database. Two independent checks: the secret
 * header Telegram echoes back from setWebhook, and the sender's chat id.
 */
export function isAuthorizedUpdate(
  headerSecret: string | undefined,
  fromId: string | number | undefined,
  configured: { webhookSecret?: string; chatId?: string },
): { ok: true } | { ok: false; reason: string } {
  if (!configured.webhookSecret) return { ok: false, reason: 'webhook secret not configured' };
  if (!headerSecret) return { ok: false, reason: 'missing secret header' };
  if (headerSecret.length !== configured.webhookSecret.length) {
    return { ok: false, reason: 'bad secret header' };
  }
  if (!timingSafeEqual(Buffer.from(headerSecret), Buffer.from(configured.webhookSecret))) {
    return { ok: false, reason: 'bad secret header' };
  }
  // The bot talks to exactly one chat. An update from anywhere else is not ours
  // even when the secret is right.
  if (!configured.chatId) return { ok: false, reason: 'chat id not configured' };
  if (String(fromId ?? '') !== String(configured.chatId)) {
    return { ok: false, reason: 'sender is not the configured chat' };
  }
  return { ok: true };
}

export interface CallbackQuery {
  id?: string;
  data?: string;
  from?: { id?: number | string };
}

/** The shape we accept. Anything else is ignored rather than guessed at. */
export function extractCallback(update: unknown): CallbackQuery | null {
  if (!update || typeof update !== 'object') return null;
  const q = (update as { callback_query?: unknown }).callback_query;
  if (!q || typeof q !== 'object') return null;
  const { id, data, from } = q as CallbackQuery;
  if (typeof data !== 'string' || !data) return null;
  return { id, data, from };
}

export type AppliedOutcome =
  | { action: 'RECORD'; notificationId: string }
  | { action: 'IGNORE'; reason: string };

/**
 * What to do with an inbound update, decided before anything is written.
 *
 * IGNORE is the default and must stay that way: an endpoint that writes on
 * anything it cannot parse is a worse failure than one that silently drops a
 * legitimate click, which the user can simply click again.
 */
export function planAppliedCallback(
  update: unknown,
  headers: { secret?: string },
  configured: { webhookSecret?: string; chatId?: string; callbackSecret?: string },
): AppliedOutcome {
  const cb = extractCallback(update);
  if (!cb) return { action: 'IGNORE', reason: 'not a callback_query' };

  const auth = isAuthorizedUpdate(headers.secret, cb.from?.id, configured);
  if (!auth.ok) return { action: 'IGNORE', reason: auth.reason };

  const notificationId = decodeAppliedToken(cb.data, configured.callbackSecret ?? '');
  if (!notificationId) return { action: 'IGNORE', reason: 'unrecognised or unsigned callback data' };

  return { action: 'RECORD', notificationId };
}
