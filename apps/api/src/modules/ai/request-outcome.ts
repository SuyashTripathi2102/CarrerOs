/**
 * What a failed network attempt says about whether Google may have billed it.
 *
 * Google charges only requests answered with a 200. A failure is safe to leave uncharged only when
 * the request provably never reached Google; otherwise the outcome is unconfirmed: the request may
 * have been processed, and billed, and only the answer lost.
 *
 * - Never sent: the connection was never made (DNS failure, connection refused, connect timeout).
 *   Node's fetch reports these as a TypeError whose `cause.code` names them.
 * - Unconfirmed: everything else, for instance the connection reset or closed after the request was
 *   written (`UND_ERR_SOCKET`), or no answer before the timeout (`TimeoutError`).
 */
const NEVER_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function causeCode(err: unknown): string | undefined {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

export function neverSent(err: unknown): boolean {
  const code = causeCode(err);
  return code !== undefined && NEVER_SENT.has(code);
}

/**
 * The attempt was abandoned at its timeout (AbortSignal.timeout). Checked by name, not instanceof:
 * the error is a DOMException made inside Node, which is not an instance of another realm's Error.
 */
export function isTimeout(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'TimeoutError';
}

/** A short reason for an attempt that failed without an answer: "timeout" or "network_<code>". */
export function failureReason(err: unknown): string {
  if (isTimeout(err)) return 'timeout';
  const code = causeCode(err);
  return code ? `network_${code}` : 'network';
}
