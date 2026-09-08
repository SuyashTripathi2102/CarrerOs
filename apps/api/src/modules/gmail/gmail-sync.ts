/**
 * Incremental Gmail sync — the decision logic, separated from the API calls so
 * it can be tested without a mailbox.
 *
 * The rules encoded here exist because of failures this project has already
 * had, not because they are theoretically tidy:
 *
 *   CHECKPOINT ORDERING   advance the cursor only AFTER a batch is durably
 *                         ingested. Advancing first loses alerts with no error.
 *   RE-SEED IS LOUD       an expired historyId silently degrades into a full
 *                         scan; if that becomes permanent nobody finds out.
 *   ZERO IS A READING     "matched messages, parsed no jobs" is the
 *                         template-changed failure and looks exactly like a
 *                         quiet week.
 */

export interface SyncState {
  /** Gmail's incremental cursor. Null on a connection that has never synced. */
  historyId: string | null;
}

export type SyncPlan =
  | { mode: 'SEED'; query: string; reason: 'first-connect' | 'history-expired' }
  | { mode: 'INCREMENTAL'; startHistoryId: string };

/**
 * How far back a first connect (or a re-seed) reaches. Bounded on purpose: an
 * unbounded historical sweep would pull years of digests, most of them for jobs
 * long filled, and every one of them would cost classification downstream.
 */
export const SEED_WINDOW_DAYS = 30;

export function seedQuery(senders: readonly string[], days = SEED_WINDOW_DAYS): string {
  if (senders.length === 0) throw new Error('seedQuery needs at least one sender');
  const from = senders.map((s) => `from:${s}`).join(' OR ');
  return `(${from}) newer_than:${days}d`;
}

export function planSync(state: SyncState, senders: readonly string[]): SyncPlan {
  if (!state.historyId) {
    return { mode: 'SEED', query: seedQuery(senders), reason: 'first-connect' };
  }
  return { mode: 'INCREMENTAL', startHistoryId: state.historyId };
}

/**
 * Gmail drops historyIds after roughly a week. The 404 is expected on a
 * connection that has been idle, and the correct response is a bounded re-seed
 * — but it must be reported, because a re-seed that silently becomes permanent
 * is a full mailbox scan on every run.
 */
export function isHistoryExpired(err: unknown): boolean {
  const e = err as { code?: number; status?: number; response?: { status?: number }; message?: string };
  const status = e?.code ?? e?.status ?? e?.response?.status;
  if (status !== 404) return false;
  return true;
}

export function reseedPlan(senders: readonly string[]): SyncPlan {
  return { mode: 'SEED', query: seedQuery(senders), reason: 'history-expired' };
}

/**
 * Whether the cursor may advance.
 *
 * The whole correctness argument of this connector sits in this function. A
 * batch that failed, even partially, must leave the cursor where it was: the
 * messages are then re-read next run, and the three dedup layers absorb the
 * repeat. The opposite ordering — advance, then ingest — turns any crash into
 * permanently lost alerts, with nothing reporting a problem.
 */
export function mayAdvanceCursor(result: {
  ingestAttempted: number;
  ingestSucceeded: number;
  errors: number;
}): boolean {
  if (result.errors > 0) return false;
  return result.ingestSucceeded === result.ingestAttempted;
}

export interface SyncOutcome {
  messagesScanned: number;
  alertsMatched: number;
  jobsParsed: number;
  parseFailures: number;
}

/**
 * A run that matched alert emails and extracted nothing from them is the
 * template-changed failure. It must be loud: it produces the same "0 new jobs"
 * as a genuinely quiet week, and telling those apart after the fact is
 * impossible.
 */
export function isSuspiciousOutcome(o: SyncOutcome): boolean {
  return o.alertsMatched > 0 && o.jobsParsed === 0;
}

export function describeOutcome(source: string, o: SyncOutcome): string {
  const base =
    `[gmail:${source}] scanned=${o.messagesScanned} matched=${o.alertsMatched} ` +
    `parsed=${o.jobsParsed} parseFailures=${o.parseFailures}`;
  return isSuspiciousOutcome(o)
    ? `${base} — MATCHED ALERTS BUT PARSED NOTHING; the email template has probably changed`
    : base;
}
