import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption for the Gmail refresh token at rest.
 *
 * WHY THIS EXISTS AT ALL. A Gmail refresh token is a long-lived key to someone's
 * mailbox. Unlike our own `passwordHash`, it cannot be one-way hashed — it must
 * be recoverable to be used — so the only protection available is encryption
 * plus never writing it anywhere else. A database dump must not hand over a
 * mailbox.
 *
 * ACCESS TOKENS ARE NEVER STORED. They live in memory for their ~1h life and are
 * re-derived from the refresh token on demand. That keeps the number of
 * long-lived secrets at exactly one.
 *
 * AES-256-GCM, not CBC: GCM is authenticated, so tampering with the stored
 * ciphertext fails loudly on decrypt instead of yielding plausible garbage that
 * is then sent to Google as a token.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the size GCM is specified for
const KEY_BYTES = 32;

/**
 * Read and validate the key. Deliberately throws rather than falling back to a
 * default or a derived-from-nothing key: a connector that silently encrypts with
 * a predictable key is worse than one that refuses to start, because it looks
 * like it is protecting something.
 */
function key(): Buffer {
  const raw = process.env.GMAIL_TOKEN_ENC_KEY?.trim();
  if (!raw) {
    throw new Error(
      'GMAIL_TOKEN_ENC_KEY is not set — refusing to store a Gmail refresh token unencrypted',
    );
  }
  const buf = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `GMAIL_TOKEN_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length}); ` +
        'generate with: openssl rand -hex 32',
    );
  }
  return buf;
}

/** `v1.<iv>.<authTag>.<ciphertext>`, all base64url. Versioned so the scheme can change. */
export function encryptToken(plaintext: string): string {
  if (!plaintext) throw new Error('refusing to encrypt an empty token');
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    c.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

export function decryptToken(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('stored Gmail token is not in the expected v1 envelope');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const d = createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64url'));
  d.setAuthTag(Buffer.from(tagB64, 'base64url'));
  // Throws on a wrong key or tampered ciphertext — that is the point of GCM.
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64url')), d.final()]).toString('utf8');
}

/**
 * Safe for logs and error messages. A refresh token must never appear in either,
 * so anything that wants to mention one uses this.
 */
export function redactToken(token: string | null | undefined): string {
  if (!token) return '(none)';
  return `${token.slice(0, 4)}…${token.slice(-2)} (${token.length} chars)`;
}
