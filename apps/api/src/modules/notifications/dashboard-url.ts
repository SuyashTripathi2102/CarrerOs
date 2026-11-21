import { BlockList, isIP } from 'net';

/**
 * Addresses a phone outside this network cannot open. The scope is complete
 * by rule, not a selection:
 *   - every block in the IANA IPv4 and IPv6 Special-Purpose Address Registries
 *     (both last updated 2025-10-09), whatever its "Globally Reachable" flag:
 *     the blocks that are reachable (anycast relays, AS112, AMT, ORCHIDv2,
 *     drone IDs) never host a dashboard, so refusing them costs nothing;
 *   - IPv4 multicast (its own registry);
 *   - for IPv6, everything outside 2000::/3, the only space allocated for
 *     global unicast. That alone covers the registry's loopback, unspecified,
 *     IPv4-mapped and NAT64 (an address that only wraps an IPv4 one), discard,
 *     dummy, SRv6, unique-local and link-local blocks, and multicast and the
 *     deprecated site-local block too.
 * dashboard-url.spec.ts tests the first and last address of every registry
 * entry, and the W2 fix harness checks that list against the registries' CSV
 * files. A block IANA adds later is accepted until it is added here.
 *
 * One list per family: a single BlockList also checks an IPv4 address against
 * its IPv6 rules as if IPv4-mapped, so an IPv4-mapped rule would refuse every
 * IPv4 address.
 */
const SPECIAL_IPV4 = new BlockList();
const SPECIAL_IPV6 = new BlockList();
const GLOBAL_UNICAST_IPV6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared (carrier-grade NAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments, with every block inside it
  ['192.0.2.0', 24], // documentation
  ['192.31.196.0', 24], // AS112
  ['192.52.193.0', 24], // AMT
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated), and 6a44
  ['192.168.0.0', 16], // private
  ['192.175.48.0', 24], // AS112 direct delegation
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
] as const) {
  SPECIAL_IPV4.addSubnet(network, prefix, 'ipv4');
}
GLOBAL_UNICAST_IPV6.addSubnet('2000::', 3, 'ipv6');
// The registry blocks inside 2000::/3; the rest lie outside it.
for (const [network, prefix] of [
  ['2001::', 23], // IETF protocol assignments: Teredo, benchmarking, AMT, AS112, ORCHID, drone IDs
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (wraps an IPv4 address)
  ['2620:4f:8000::', 48], // AS112 direct delegation
  ['3fff::', 20], // documentation
] as const) {
  SPECIAL_IPV6.addSubnet(network, prefix, 'ipv6');
}

/**
 * Names that never resolve on the public internet: localhost; the mDNS .local;
 * the private-use .internal and .home.arpa (all of .arpa is refused, as it
 * holds no web hosts); and the special-use .test, .example, .invalid, .onion
 * and .alt (RFC 6761, 7686, 9476). Not refused: example.com, .net and .org,
 * which are reserved for documentation but resolve publicly; and a public name
 * whose DNS points at a private address, since no lookup is made.
 */
const LOCAL_NAME =
  /(^|\.)(localhost|local|internal|arpa|test|example|invalid|onion|alt)$/;

/**
 * The dashboard address for links inside Telegram messages, or null when there
 * is no address a phone could open.
 *
 * Telegram rejects the ENTIRE message when one button URL is unacceptable, so a
 * bad value here costs the alert, not just the button.
 */
export function publicDashboardUrl(
  raw: string | null | undefined,
): string | null {
  const value = raw?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isPublicHost(url.hostname)) return null;

  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * The URL parser has already normalized the host: IPv4 in any notation
 * (127.1, 2130706433, 0x7f000001) becomes dotted decimal, IPv6 is compressed
 * and bracketed, names are lower-cased.
 */
function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host.startsWith('[') && host.endsWith(']')) {
    const ip = host.slice(1, -1);
    return (
      isIP(ip) === 6 &&
      GLOBAL_UNICAST_IPV6.check(ip, 'ipv6') &&
      !SPECIAL_IPV6.check(ip, 'ipv6')
    );
  }
  if (isIP(host) === 4) return !SPECIAL_IPV4.check(host, 'ipv4');

  // A trailing dot names the same host ("localhost." is localhost).
  const name = host.replace(/\.$/, '');
  if (!name.includes('.')) return false; // dotless: a container or LAN name
  return !LOCAL_NAME.test(name);
}
