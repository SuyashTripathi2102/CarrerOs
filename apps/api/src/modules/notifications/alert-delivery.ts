import type { TelegramFailure } from './channels';

/**
 * The delivery record of one job alert, kept on the alert's notification row
 * (`payload.delivery`).
 *
 * The row is written before the first send, so it is the alert's outbox entry:
 * whatever happens to the process or the database after a send, the row still
 * says what was attempted, and nothing re-sends an alert that may already have
 * arrived.
 *
 *   QUEUED   recorded; no send attempted yet. Safe to send.
 *   SENDING  a send may be in flight. Written before the request leaves, so a
 *            crash or a lost reply leaves this state, never QUEUED or RETRY.
 *   SENT     the channel confirmed it (or there is no channel: in-app only).
 *   RETRY    the channel confirmed it did NOT take the message. Due again at
 *            nextAttemptAt.
 *   FAILED   never sent automatically again: refused for good, or out of
 *            attempts. The alert stays visible in-app.
 *   UNKNOWN  a send went out and its outcome is unknown (timeout, connection
 *            lost, process stopped mid-send). Never re-sent automatically: the
 *            alert is still in-app and in the morning brief, and a second push
 *            of an alert that did arrive is the failure this record exists to
 *            prevent.
 */
export const DELIVERY_STATUSES = [
  'QUEUED',
  'SENDING',
  'SENT',
  'RETRY',
  'FAILED',
  'UNKNOWN',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface DeliveryState {
  status: DeliveryStatus;
  /** Sends that counted. A send refused for configuration does not count. */
  attempts: number;
  /** Bumped on every change; a write applies only to the version it read. */
  version: number;
  /** ISO time of the last change. */
  updatedAt: string;
  /** RETRY and QUEUED: not before this ISO time. */
  nextAttemptAt?: string;
  lastError?: string;
  channel?: 'telegram' | 'in-app';
}

/** The result of one send, as the channel reported it. */
export type SendOutcome =
  | { ok: true }
  | {
      ok: false;
      failure: TelegramFailure;
      error: string;
      retryAfterSec?: number;
    };

export const MAX_ATTEMPTS = 6;
export const FIRST_RETRY_DELAY_MS = 10 * 60_000;
export const MAX_RETRY_DELAY_MS = 6 * 3_600_000;
export const CONFIG_RETRY_DELAY_MS = 3_600_000;
/** Far longer than a send may take (TELEGRAM_TIMEOUT_MS), so only a dead attempt is this old. */
export const STALE_SENDING_MS = 5 * 60_000;
/**
 * A due alert that a retry pass picked but did not send (a gate held it, or
 * sending was held part-way through the pass) is not picked again for this
 * long, so it cannot hold a place in every pass.
 */
export const RECHECK_DELAY_MS = 60 * 60_000;

const ERROR_MAX_CHARS = 300;

/**
 * What a row's payload says about delivery.
 *
 *   ok, legacy  the row has no record: it was written before the record
 *               existed. Under the earlier code a row survived only a send that
 *               succeeded, or one recorded in-app, so it reads as SENT and
 *               re-sending it could only produce a duplicate.
 *   ok          a well-formed record.
 *   not ok      a record that is there but malformed: not an object, a status
 *               outside DELIVERY_STATUSES, a missing or impossible field. Every
 *               caller must treat it as "do not send and do not write": the row
 *               may describe an alert that arrived, and guessing otherwise is
 *               how an alert gets sent twice.
 */
export type DeliveryRead =
  | { ok: true; state: DeliveryState; legacy: boolean }
  | { ok: false; problem: string };

const LEGACY: DeliveryState = {
  status: 'SENT',
  attempts: 0,
  version: 0,
  updatedAt: new Date(0).toISOString(),
};

export function parseDelivery(payload: unknown): DeliveryRead {
  if (!isRecord(payload)) return bad('the payload is not an object');
  const d = payload.delivery;
  if (d === undefined) return { ok: true, state: { ...LEGACY }, legacy: true };
  if (!isRecord(d)) return bad(`the record is ${shown(d)}, not an object`);

  const status = d.status;
  if (!isStatus(status)) return bad(`unknown status ${shown(status)}`);
  if (!isCount(d.version) || d.version < 1)
    return bad(`version ${shown(d.version)} is not a positive integer`);
  if (!isCount(d.attempts))
    return bad(`attempts ${shown(d.attempts)} is not a whole number`);
  if (!isIsoTime(d.updatedAt))
    return bad(`updatedAt ${shown(d.updatedAt)} is not an ISO time`);
  if (d.nextAttemptAt !== undefined && !isIsoTime(d.nextAttemptAt))
    return bad(`nextAttemptAt ${shown(d.nextAttemptAt)} is not an ISO time`);
  if (d.lastError !== undefined && typeof d.lastError !== 'string')
    return bad(`lastError ${shown(d.lastError)} is not text`);
  if (
    d.channel !== undefined &&
    d.channel !== 'telegram' &&
    d.channel !== 'in-app'
  )
    return bad(`unknown channel ${shown(d.channel)}`);

  return {
    ok: true,
    legacy: false,
    state: {
      status,
      attempts: d.attempts,
      version: d.version,
      updatedAt: d.updatedAt,
      ...(d.nextAttemptAt !== undefined
        ? { nextAttemptAt: d.nextAttemptAt }
        : {}),
      ...(d.lastError !== undefined ? { lastError: d.lastError } : {}),
      ...(d.channel !== undefined ? { channel: d.channel } : {}),
    },
  };
}

function bad(problem: string): DeliveryRead {
  return { ok: false, problem };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStatus(v: unknown): v is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly unknown[]).includes(v);
}

function isCount(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

/** Exactly the form toISOString() writes: anything else (24:00, 30 February, no zone) is refused. */
function isIsoTime(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = Date.parse(v);
  return !Number.isNaN(t) && new Date(t).toISOString() === v;
}

function shown(v: unknown): string {
  if (v === undefined) return 'missing';
  if (Array.isArray(v)) return 'a list';
  const text = JSON.stringify(v);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** A payload with its delivery record replaced; every other key is kept. */
export function withDelivery(
  payload: unknown,
  state: DeliveryState,
): Record<string, unknown> {
  const base =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  return { ...base, delivery: state };
}

export function queued(now: Date): DeliveryState {
  return {
    status: 'QUEUED',
    attempts: 0,
    version: 1,
    updatedAt: now.toISOString(),
  };
}

/** Recorded in-app with no channel to send to; the next version of `prev`, if any. */
export function inAppOnly(
  prev: DeliveryState | null,
  now: Date,
): DeliveryState {
  return {
    status: 'SENT',
    attempts: prev?.attempts ?? 0,
    version: (prev?.version ?? 0) + 1,
    updatedAt: now.toISOString(),
    channel: 'in-app',
  };
}

/** The claim before a send: the next version, in SENDING. */
export function startSending(
  prev: DeliveryState | null,
  now: Date,
): DeliveryState {
  return {
    status: 'SENDING',
    attempts: prev?.attempts ?? 0,
    version: (prev?.version ?? 0) + 1,
    updatedAt: now.toISOString(),
    channel: 'telegram',
    ...(prev?.lastError ? { lastError: prev.lastError } : {}),
  };
}

/** May a send start now? Only QUEUED and RETRY ever start one, and RETRY only once due. */
export function isDue(state: DeliveryState, now: Date): boolean {
  if (state.status !== 'QUEUED' && state.status !== 'RETRY') return false;
  return (
    !state.nextAttemptAt || Date.parse(state.nextAttemptAt) <= now.getTime()
  );
}

/** A SENDING record no live attempt could still own. */
export function isStale(state: DeliveryState, now: Date): boolean {
  return (
    state.status === 'SENDING' &&
    now.getTime() - Date.parse(state.updatedAt) > STALE_SENDING_MS
  );
}

/** Delay before the next try, after `attempts` counted failures: 10 min, doubling, capped at 6 h. */
export function retryDelayMs(attempts: number): number {
  return Math.min(
    FIRST_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1),
    MAX_RETRY_DELAY_MS,
  );
}

/** The record after a send that was claimed with `sending`. */
export function afterSend(
  sending: DeliveryState,
  outcome: SendOutcome,
  now: Date,
): DeliveryState {
  const base = {
    version: sending.version,
    updatedAt: now.toISOString(),
    channel: sending.channel,
  };
  if (outcome.ok) {
    return { ...base, status: 'SENT', attempts: sending.attempts + 1 };
  }

  const lastError = outcome.error.slice(0, ERROR_MAX_CHARS);
  const attempts = sending.attempts + 1;
  const retryAt = (ms: number) => new Date(now.getTime() + ms).toISOString();

  switch (outcome.failure) {
    case 'rejected':
      return { ...base, status: 'FAILED', attempts, lastError };
    case 'ambiguous':
      return { ...base, status: 'UNKNOWN', attempts, lastError };
    case 'config':
      // Not the alert's fault and not counted: it waits for the configuration
      // to be fixed (which needs a restart) rather than using up its attempts.
      return {
        ...base,
        status: 'RETRY',
        attempts: sending.attempts,
        lastError,
        nextAttemptAt: retryAt(CONFIG_RETRY_DELAY_MS),
      };
    case 'rate-limited':
    case 'server':
    case 'not-sent': {
      if (attempts >= MAX_ATTEMPTS) {
        return {
          ...base,
          status: 'FAILED',
          attempts,
          lastError: `gave up after ${attempts} attempts: ${lastError}`,
        };
      }
      const wait =
        outcome.failure === 'rate-limited' &&
        outcome.retryAfterSec !== undefined
          ? Math.max(outcome.retryAfterSec * 1000, 1000)
          : retryDelayMs(attempts);
      return {
        ...base,
        status: 'RETRY',
        attempts,
        lastError,
        nextAttemptAt: retryAt(wait),
      };
    }
  }
}

/** A SENDING record whose attempt died: its outcome is unknown. */
export function abandoned(state: DeliveryState, now: Date): DeliveryState {
  return {
    ...state,
    status: 'UNKNOWN',
    attempts: state.attempts + 1,
    version: state.version + 1,
    updatedAt: now.toISOString(),
    lastError: 'the attempt stopped before its outcome was recorded',
  };
}
