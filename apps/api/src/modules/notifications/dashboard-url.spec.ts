import { publicDashboardUrl } from './dashboard-url';

/**
 * Every entry of the IANA IPv4 and IPv6 Special-Purpose Address Registries
 * (both last updated 2025-10-09) with its first and last address, generated
 * from the registries' CSV files. The W2 fix harness compares the blocks here
 * with those files, so an entry missing from this list fails that check.
 */
const IANA_SPECIAL_PURPOSE: [block: string, first: string, last: string][] = [
  ['0.0.0.0/8', '0.0.0.0', '0.255.255.255'], // This network
  ['0.0.0.0/32', '0.0.0.0', '0.0.0.0'], // This host on this network
  ['10.0.0.0/8', '10.0.0.0', '10.255.255.255'], // Private-Use
  ['100.64.0.0/10', '100.64.0.0', '100.127.255.255'], // Shared Address Space
  ['127.0.0.0/8', '127.0.0.0', '127.255.255.255'], // Loopback
  ['169.254.0.0/16', '169.254.0.0', '169.254.255.255'], // Link Local
  ['172.16.0.0/12', '172.16.0.0', '172.31.255.255'], // Private-Use
  ['192.0.0.0/24', '192.0.0.0', '192.0.0.255'], // IETF Protocol Assignments
  ['192.0.0.0/29', '192.0.0.0', '192.0.0.7'], // IPv4 Service Continuity Prefix
  ['192.0.0.8/32', '192.0.0.8', '192.0.0.8'], // IPv4 dummy address
  ['192.0.0.9/32', '192.0.0.9', '192.0.0.9'], // Port Control Protocol Anycast
  ['192.0.0.10/32', '192.0.0.10', '192.0.0.10'], // Traversal Using Relays around NAT Anycast
  ['192.0.0.170/32', '192.0.0.170', '192.0.0.170'], // NAT64/DNS64 Discovery
  ['192.0.0.171/32', '192.0.0.171', '192.0.0.171'], // NAT64/DNS64 Discovery
  ['192.0.2.0/24', '192.0.2.0', '192.0.2.255'], // Documentation (TEST-NET-1)
  ['192.31.196.0/24', '192.31.196.0', '192.31.196.255'], // AS112-v4
  ['192.52.193.0/24', '192.52.193.0', '192.52.193.255'], // AMT
  ['192.88.99.0/24', '192.88.99.0', '192.88.99.255'], // Deprecated (6to4 Relay Anycast)
  ['192.88.99.2/32', '192.88.99.2', '192.88.99.2'], // 6a44-relay anycast address
  ['192.168.0.0/16', '192.168.0.0', '192.168.255.255'], // Private-Use
  ['192.175.48.0/24', '192.175.48.0', '192.175.48.255'], // Direct Delegation AS112 Service
  ['198.18.0.0/15', '198.18.0.0', '198.19.255.255'], // Benchmarking
  ['198.51.100.0/24', '198.51.100.0', '198.51.100.255'], // Documentation (TEST-NET-2)
  ['203.0.113.0/24', '203.0.113.0', '203.0.113.255'], // Documentation (TEST-NET-3)
  ['240.0.0.0/4', '240.0.0.0', '255.255.255.255'], // Reserved
  ['255.255.255.255/32', '255.255.255.255', '255.255.255.255'], // Limited Broadcast
  ['::1/128', '::1', '::1'], // Loopback Address
  ['::/128', '::', '::'], // Unspecified Address
  ['::ffff:0:0/96', '::ffff:0:0', '::ffff:ffff:ffff'], // IPv4-mapped Address
  ['64:ff9b::/96', '64:ff9b::', '64:ff9b::ffff:ffff'], // IPv4-IPv6 Translat.
  ['64:ff9b:1::/48', '64:ff9b:1::', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff'], // IPv4-IPv6 Translat.
  ['100::/64', '100::', '100::ffff:ffff:ffff:ffff'], // Discard-Only Address Block
  ['100:0:0:1::/64', '100:0:0:1::', '100::1:ffff:ffff:ffff:ffff'], // Dummy IPv6 Prefix
  ['2001::/23', '2001::', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'], // IETF Protocol Assignments
  ['2001::/32', '2001::', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff'], // TEREDO
  ['2001:1::1/128', '2001:1::1', '2001:1::1'], // Port Control Protocol Anycast
  ['2001:1::2/128', '2001:1::2', '2001:1::2'], // Traversal Using Relays around NAT Anycast
  ['2001:1::3/128', '2001:1::3', '2001:1::3'], // DNS-SD Service Registration Protocol Anycast
  ['2001:2::/48', '2001:2::', '2001:2:0:ffff:ffff:ffff:ffff:ffff'], // Benchmarking
  ['2001:3::/32', '2001:3::', '2001:3:ffff:ffff:ffff:ffff:ffff:ffff'], // AMT
  ['2001:4:112::/48', '2001:4:112::', '2001:4:112:ffff:ffff:ffff:ffff:ffff'], // AS112-v6
  ['2001:10::/28', '2001:10::', '2001:1f:ffff:ffff:ffff:ffff:ffff:ffff'], // Deprecated (previously ORCHID)
  ['2001:20::/28', '2001:20::', '2001:2f:ffff:ffff:ffff:ffff:ffff:ffff'], // ORCHIDv2
  ['2001:30::/28', '2001:30::', '2001:3f:ffff:ffff:ffff:ffff:ffff:ffff'], // Drone Remote ID Protocol Entity Tags (DETs) Prefix
  ['2001:db8::/32', '2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'], // Documentation
  ['2002::/16', '2002::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'], // 6to4
  [
    '2620:4f:8000::/48',
    '2620:4f:8000::',
    '2620:4f:8000:ffff:ffff:ffff:ffff:ffff',
  ], // Direct Delegation AS112 Service
  ['3fff::/20', '3fff::', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'], // Documentation
  ['5f00::/16', '5f00::', '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff'], // Segment Routing (SRv6) SIDs
  ['fc00::/7', 'fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'], // Unique-Local
  ['fe80::/10', 'fe80::', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'], // Link-Local Unicast
];

const urlFor = (ip: string) => `http://${ip.includes(':') ? `[${ip}]` : ip}`;

describe('publicDashboardUrl', () => {
  it.each([
    ['http://localhost:3000'],
    ['https://localhost'],
    ['HTTP://LOCALHOST:3000/'],
    ['http://app.localhost:3000'],
    ['http://127.0.0.1:3000'],
    ['http://0.0.0.0:3000'],
    ['http://[::1]:3000'],
    ['http://careeros-web:3000'],
  ])('refuses %s, which a phone cannot open', (raw) => {
    expect(publicDashboardUrl(raw)).toBeNull();
  });

  it.each([
    // loopback in other spellings
    ['http://localhost.:3000'],
    ['http://app.localhost.'],
    ['http://127.1'],
    ['http://2130706433'],
    ['http://0x7f000001'],
    ['http://0'],
    ['http://[0:0:0:0:0:0:0:1]'],
    ['http://[::]'],
    // IPv6 that only wraps IPv4
    ['http://[::ffff:127.0.0.1]'],
    ['http://[::ffff:8.8.8.8]'],
    ['http://[64:ff9b::808:808]'],
    // private, shared and link-local IPv4
    ['http://10.0.0.5:3000'],
    ['http://172.16.0.1'],
    ['http://172.31.255.255'],
    ['http://192.168.1.10:3000'],
    ['http://100.64.1.1'],
    ['http://169.254.169.254'],
    // documentation, multicast and broadcast IPv4
    ['https://203.0.113.7'],
    ['http://224.0.0.1'],
    ['http://255.255.255.255'],
    // private, link-local, documentation and multicast IPv6
    ['http://[fd00::1]'],
    ['http://[fe80::1]'],
    ['http://[2001:db8::1]:3000'],
    ['http://[ff02::1]'],
    // names that only resolve on this machine or network
    ['http://careeros.local'],
    ['http://nas.home.arpa'],
    ['http://svc.internal'],
    // special-use names that never resolve publicly
    ['http://careeros.test'],
    ['http://careeros.example'],
    ['http://careeros.invalid'],
    ['http://abcdefghijklmnop.onion'],
    ['http://careeros.alt'],
    ['http://ipv4only.arpa'],
    // IPv6 outside 2000::/3, the global unicast space
    ['http://[4000::1]'],
    ['http://[e000::1]'],
    ['http://[fec0::1]'],
  ])('refuses %s, a special-use address', (raw) => {
    expect(publicDashboardUrl(raw)).toBeNull();
  });

  it.each(IANA_SPECIAL_PURPOSE)(
    'refuses %s, an IANA special-purpose block, at its first and last address',
    (_block, first, last) => {
      expect(publicDashboardUrl(urlFor(first))).toBeNull();
      expect(publicDashboardUrl(urlFor(last))).toBeNull();
    },
  );

  it.each([
    [undefined],
    [null],
    [''],
    ['   '],
    ['not a url'],
    ['ftp://careeros.example.com'],
    ['javascript:alert(1)'],
    ['https://example.com:99999'],
    ['https://exa mple.com'],
  ])('treats %s as no dashboard', (raw) => {
    expect(publicDashboardUrl(raw)).toBeNull();
  });

  it.each([
    ['https://careeros.example.com', 'https://careeros.example.com'],
    ['https://careeros.example.com/', 'https://careeros.example.com'],
    ['  https://careeros.example.com/  ', 'https://careeros.example.com'],
    ['https://example.com/careeros/', 'https://example.com/careeros'],
    ['http://8.8.8.8:3000', 'http://8.8.8.8:3000'],
    ['http://172.32.0.1', 'http://172.32.0.1'],
    ['http://100.128.0.1', 'http://100.128.0.1'],
    ['http://[2606:4700:4700::1111]', 'http://[2606:4700:4700::1111]'],
    ['https://careeros.example.org', 'https://careeros.example.org'],
  ])('accepts %s', (raw, expected) => {
    expect(publicDashboardUrl(raw)).toBe(expected);
  });

  it.each([
    // the public addresses either side of special-purpose blocks
    ['192.31.195.255'],
    ['192.31.197.0'],
    ['192.52.192.255'],
    ['192.52.194.0'],
    ['192.88.98.255'],
    ['192.88.100.0'],
    ['192.175.47.255'],
    ['192.175.49.0'],
    ['223.255.255.255'],
    ['2001:200::1'],
    ['2003::1'],
    ['2620:4f:7fff:ffff::1'],
    ['2620:4f:8001::1'],
    ['3ffe:ffff::1'],
    ['3fff:1000::1'],
  ])('accepts %s, just outside a special-purpose block', (ip) => {
    expect(publicDashboardUrl(urlFor(ip))).toBe(new URL(urlFor(ip)).origin);
  });

  it('drops credentials, the query and the fragment', () => {
    expect(
      publicDashboardUrl(
        'https://user:secret@careeros.example.com/app/?token=abc#x',
      ),
    ).toBe('https://careeros.example.com/app');
  });
});
