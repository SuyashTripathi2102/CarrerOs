import { isIP } from 'node:net';

export interface ListenHost {
  /** What app.listen() is given. */
  address: string;
  /** Only this machine can connect. */
  loopback: boolean;
}

/**
 * The address the API listens on, from HOST.
 *
 * Empty or unset means 127.0.0.1: this machine only. Accepted otherwise: "localhost" (any case),
 * and IPv4 or IPv6 literals, with or without brackets around IPv6; 0.0.0.0 and :: mean every
 * interface. Anything else, a hostname above all, is refused rather than guessed at: a hostname
 * binds wherever it happens to resolve, and on a server that can be a public address.
 *
 * HOST=0.0.0.0 inside a container (the Dockerfile sets it) only lets the container's published port
 * reach the API; which interfaces of the host that port is published on is set in compose.prod.yml.
 */
export function listenHost(raw: string | undefined): ListenHost {
  const value = (raw ?? '').trim();
  if (!value) return { address: '127.0.0.1', loopback: true };

  const literal =
    value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (literal.toLowerCase() === 'localhost')
    return { address: 'localhost', loopback: true };

  const family = isIP(literal);
  if (family === 0) {
    throw new Error(
      `HOST "${value}" is not an IP address or "localhost"; refusing to guess where to listen (leave it empty for 127.0.0.1)`,
    );
  }
  return { address: literal, loopback: isLoopback(literal, family) };
}

function isLoopback(address: string, family: number): boolean {
  if (family === 4) return address.startsWith('127.');
  const a = address.toLowerCase();
  return a === '::1' || a === '0:0:0:0:0:0:0:1' || /^::ffff:127\./.test(a);
}
