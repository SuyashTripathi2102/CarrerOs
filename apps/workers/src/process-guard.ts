/**
 * Survive the network, die on real defects.
 *
 * This process talks to hundreds of third-party HTTP servers it does not
 * control. A truncated or malformed response is NORMAL operating conditions for
 * a crawler, not an exceptional state — but undici raises those from its own
 * parser, asynchronously, so no try/catch around fetch() can ever see them:
 *
 *   AssertionError [ERR_ASSERTION]: false == true
 *       at Parser.finish (node:internal/deps/undici/undici:7388:9)
 *       at TLSSocket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)
 *
 * On 2026-08-23 one truncated Lever board (38.7 MB, unterminated JSON) did
 * exactly that. With no uncaughtException handler it killed the whole workers
 * process — and because `tsx watch` restarts on a FILE CHANGE and not on a
 * crash, the process stayed dead for 592 minutes. That took down every crawl
 * AND the evaluation belt, which sat at active:1 / workers:0 with its next fire
 * time ten hours in the past.
 *
 * Nothing alerted. The queue simply looked quiet — the exact failure shape
 * already recorded as "a missing schedule looks like a drained queue".
 *
 * A transport fault carries no application state, so it is logged and
 * swallowed. Anything else is a genuine bug and still exits non-zero: a blanket
 * uncaughtException handler that swallows everything would trade a loud crash
 * for silent corruption, which is a worse deal.
 */

/** Socket- and protocol-level failures. None of these imply corrupted state. */
const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPROTO',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_RESPONSE_STATUS_CODE',
]);

export function isTransportFault(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; stack?: unknown; cause?: unknown };

  if (typeof e.code === 'string' && TRANSPORT_CODES.has(e.code)) return true;

  // undici raises parser faults as BARE assertions — no useful code, no
  // message. The only reliable marker is the frame they come from, so scope
  // the match tightly to undici: a failed assertion in our own code must still
  // kill the process.
  if (e.code === 'ERR_ASSERTION' && typeof e.stack === 'string' && e.stack.includes('undici')) {
    return true;
  }

  // fetch() wraps the real cause ("TypeError: fetch failed").
  return e.cause !== undefined && e.cause !== err ? isTransportFault(e.cause) : false;
}

type Sink = Pick<Console, 'error'>;

export function installProcessGuard(log: Sink = console, exit = process.exit): void {
  const handle = (kind: string) => (err: unknown) => {
    if (isTransportFault(err)) {
      // Loud on purpose. Swallowing silently is how a degraded crawler looks
      // exactly like a healthy one.
      log.error(`[process-guard] ${kind}: transport fault survived — ${describe(err)}`);
      return;
    }
    log.error(`[process-guard] ${kind}: not a transport fault, exiting`, err);
    exit(1);
  };

  process.on('uncaughtException', handle('uncaughtException'));
  process.on('unhandledRejection', handle('unhandledRejection'));
}

function describe(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e?.code === 'string' ? e.code : 'no-code';
  const msg = typeof e?.message === 'string' ? e.message : String(err);
  return `${code}: ${msg.slice(0, 120)}`;
}
