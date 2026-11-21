/**
 * Telling "the source had nothing" apart from "we never reached the source".
 *
 * Aggregator adapters swallow per-request errors so one bad page cannot lose
 * the rest. Without a tally, a crawl in which EVERY request failed returns []
 * and is recorded as a successful zero-job crawl. That happened on 2026-11-10:
 * the daily FreeHire and Jooble crawls ran the second the laptop woke, before
 * Wi-Fi was back, and logged SUCCEEDED found=0.
 *
 * Only error codes and HTTP statuses leave this module, never raw messages:
 * fetchJson errors carry the full URL, and some sources put their key in it.
 */

export type FetchFailureKind = 'transient' | 'permanent';

const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/**
 * Which HTTP statuses can clear up on their own:
 *   408 (timeout), 429 (rate limited) and 5xx   transient: retried with the job's bounded backoff
 *   401, 403, 404 and every other 4xx            permanent: a bad key, a refusal or a gone page
 * Retry-After is not read: the adapters' HTTP helpers keep only the status. A 429 that lasts all the
 * job's attempts (a daily quota, say) costs one request per query per attempt, then fails the job.
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Network trouble, timeouts, 408, 429 and 5xx can clear up on their own, so they
 * are retried. Other 4xx (a bad key, a refusal, a page gone) and unparseable
 * bodies will not fix themselves in minutes.
 */
export function describeFetchError(err: unknown): {
  kind: FetchFailureKind;
  code: string;
} {
  const e = err as {
    code?: unknown;
    cause?: { code?: unknown };
    message?: unknown;
  } | null;
  const code =
    typeof e?.cause?.code === 'string'
      ? e.cause.code
      : typeof e?.code === 'string'
        ? e.code
        : undefined;
  if (code && TRANSIENT_CODES.has(code)) return { kind: 'transient', code };

  const message = typeof e?.message === 'string' ? e.message : String(err);
  const status = /->\s*(\d{3})\b/.exec(message)?.[1];
  if (status) {
    const s = Number(status);
    return {
      kind: isTransientStatus(s) ? 'transient' : 'permanent',
      code: `HTTP ${s}`,
    };
  }
  if (/\btime(d)?\s?out\b/i.test(message))
    return { kind: 'transient', code: 'timeout' };
  if (/fetch failed/i.test(message))
    return { kind: 'transient', code: 'fetch failed' };
  if (err instanceof SyntaxError)
    return { kind: 'permanent', code: 'invalid JSON' };
  return { kind: 'permanent', code: err instanceof Error ? err.name : 'error' };
}

export class SourceUnreachableError extends Error {
  constructor(
    readonly source: string,
    readonly kind: FetchFailureKind,
    readonly attempted: number,
    summary: string,
  ) {
    super(`${source}: all ${attempted} requests failed (${summary})`);
    this.name = 'SourceUnreachableError';
  }
}

/**
 * The source cannot be crawled as configured (no key set), so no request was made. Not a failure
 * and not a zero: the processor records nothing and says so in the log. `missing` names the
 * settings only, never their values.
 */
export class SourceNotConfiguredError extends Error {
  constructor(
    readonly source: string,
    readonly missing: string,
  ) {
    super(`${source}: not configured (${missing} not set)`);
    this.name = 'SourceNotConfiguredError';
  }
}

/**
 * Counts one crawl's requests; throws only when not a single one succeeded. When the failures were
 * of both kinds, the crawl counts as transient, so it is retried: one network failure among the
 * refusals means the source may answer next time.
 */
export class FetchTally {
  private attempted = 0;
  private failed = 0;
  private readonly codes = new Map<string, number>();
  private anyTransient = false;

  succeeded(): void {
    this.attempted++;
  }

  failedWith(err: unknown): void {
    this.attempted++;
    this.failed++;
    const { kind, code } = describeFetchError(err);
    if (kind === 'transient') this.anyTransient = true;
    this.codes.set(code, (this.codes.get(code) ?? 0) + 1);
  }

  /**
   * A source that answered, even with zero rows, is reachable: that zero is
   * real. A crawl that made no request at all has nothing to judge; an adapter
   * that skips for want of a key throws SourceNotConfiguredError before this.
   */
  assertReachable(source: string): void {
    if (this.attempted === 0 || this.failed < this.attempted) return;
    const summary = [...this.codes].map(([c, n]) => `${c} ×${n}`).join(', ');
    throw new SourceUnreachableError(
      source,
      this.anyTransient ? 'transient' : 'permanent',
      this.attempted,
      summary,
    );
  }
}
