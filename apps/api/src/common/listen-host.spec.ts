import { listenHost } from './listen-host';

describe('listenHost: where the API listens', () => {
  it.each([undefined, '', '   '])(
    'listens on 127.0.0.1, this machine only, when HOST is %p',
    (raw) => {
      expect(listenHost(raw)).toEqual({ address: '127.0.0.1', loopback: true });
    },
  );

  it.each([
    ['127.0.0.1', '127.0.0.1', true],
    [' 127.0.0.1 ', '127.0.0.1', true],
    ['127.0.1.1', '127.0.1.1', true],
    ['localhost', 'localhost', true],
    ['LOCALHOST', 'localhost', true],
    ['::1', '::1', true],
    ['[::1]', '::1', true],
    ['::ffff:127.0.0.1', '::ffff:127.0.0.1', true],
    ['0.0.0.0', '0.0.0.0', false],
    ['::', '::', false],
    ['192.168.1.20', '192.168.1.20', false],
    ['2001:db8::7', '2001:db8::7', false],
    ['[2001:db8::7]', '2001:db8::7', false],
  ])('accepts %p as %p (loopback: %p)', (raw, address, loopback) => {
    expect(listenHost(raw)).toEqual({ address, loopback });
  });

  it.each([
    ['my-laptop', 'a hostname: it binds wherever it resolves'],
    ['api.example.com', 'a domain name'],
    ['localhost.', 'localhost with a trailing dot (a lookup, not the literal)'],
    ['256.1.1.1', 'an IPv4 address out of range'],
    ['127.1', 'a shortened IPv4 address'],
    ['1.2.3.4:3001', 'an address with a port'],
    ['::1]', 'unbalanced brackets'],
    ['http://127.0.0.1', 'a URL'],
  ])('refuses %p (%s) instead of guessing', (raw) => {
    expect(() => listenHost(raw)).toThrow(
      'is not an IP address or "localhost"',
    );
  });
});
