import { encryptToken, decryptToken, redactToken } from './gmail-crypto';

/**
 * A Gmail refresh token is a long-lived key to someone's mailbox. It cannot be
 * hashed like a password because it must be recoverable to be used, so
 * encryption plus never-log-it is the entire protection. These tests pin the
 * properties that make that true.
 */

const KEY_A = 'a'.repeat(64); // 32 bytes hex
const KEY_B = 'b'.repeat(64);

describe('gmail token encryption', () => {
  const original = process.env.GMAIL_TOKEN_ENC_KEY;
  beforeEach(() => {
    process.env.GMAIL_TOKEN_ENC_KEY = KEY_A;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.GMAIL_TOKEN_ENC_KEY;
    else process.env.GMAIL_TOKEN_ENC_KEY = original;
  });

  it('round-trips a token', () => {
    const t = '1//0gExampleRefreshTokenValue_with-punctuation';
    expect(decryptToken(encryptToken(t))).toBe(t);
  });

  it('never emits the plaintext in the stored envelope', () => {
    // The obvious catastrophic bug: "encrypt" that stores the token verbatim.
    const t = 'SUPERSECRET-refresh-token';
    const stored = encryptToken(t);
    expect(stored).not.toContain(t);
    expect(stored).not.toContain('SUPERSECRET');
  });

  it('produces different ciphertext each time (random IV)', () => {
    // A deterministic ciphertext would leak that two rows hold the same token.
    const t = 'same-token';
    expect(encryptToken(t)).not.toBe(encryptToken(t));
  });

  it('FAILS LOUDLY on a wrong key rather than returning garbage', () => {
    const stored = encryptToken('token');
    process.env.GMAIL_TOKEN_ENC_KEY = KEY_B;
    // GCM is authenticated precisely so this throws instead of yielding
    // plausible nonsense that would then be sent to Google as a credential.
    expect(() => decryptToken(stored)).toThrow();
  });

  it('FAILS LOUDLY on tampered ciphertext', () => {
    const stored = encryptToken('token');
    const parts = stored.split('.');
    parts[3] = Buffer.from('tampered-value').toString('base64url');
    expect(() => decryptToken(parts.join('.'))).toThrow();
  });

  it('rejects a malformed envelope', () => {
    expect(() => decryptToken('not-an-envelope')).toThrow(/v1 envelope/);
    expect(() => decryptToken('v2.a.b.c')).toThrow(/v1 envelope/);
  });

  describe('key validation — refuse rather than pretend', () => {
    it('throws when the key is absent', () => {
      delete process.env.GMAIL_TOKEN_ENC_KEY;
      // A connector that silently encrypts with a default or derived key is
      // worse than one that will not start: it looks like it is protecting
      // something.
      expect(() => encryptToken('t')).toThrow(/not set/);
    });

    it('throws when the key is the wrong length', () => {
      process.env.GMAIL_TOKEN_ENC_KEY = 'tooshort';
      expect(() => encryptToken('t')).toThrow(/32 bytes/);
    });

    it('accepts base64 as well as hex', () => {
      process.env.GMAIL_TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
      expect(decryptToken(encryptToken('x'))).toBe('x');
    });
  });

  it('refuses to encrypt an empty token', () => {
    // An empty refresh token means the OAuth exchange failed; storing it would
    // produce a connection that looks ACTIVE and can never sync.
    expect(() => encryptToken('')).toThrow(/empty/);
  });
});

describe('redactToken', () => {
  it('never reveals enough to be usable', () => {
    const t = '1//0gVeryLongRefreshTokenValueHere';
    const r = redactToken(t);
    expect(r).not.toContain('VeryLongRefreshToken');
    expect(r).toContain(String(t.length));
  });

  it('handles absent tokens', () => {
    expect(redactToken(null)).toBe('(none)');
    expect(redactToken(undefined)).toBe('(none)');
  });
});
