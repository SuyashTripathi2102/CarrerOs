import { GMAIL_SCOPES, isDeadGrant } from './gmail-oauth.service';

/**
 * The two properties of the OAuth layer that are worth pinning in a test: the
 * scope we ask for, and our ability to tell a dead grant from a blip.
 *
 * The consent/exchange flows themselves are thin wrappers over
 * google-auth-library and are exercised by the live connect, not mocked here —
 * mocking Google's client would test the mock.
 */

describe('requested scope', () => {
  it('is read-only, and ONLY read-only', () => {
    // Widening this is a security decision. The test exists so it cannot happen
    // as a quiet convenience during some later feature.
    expect(GMAIL_SCOPES).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
  });

  it('never requests send, modify, labels or full access', () => {
    const joined = GMAIL_SCOPES.join(' ');
    for (const forbidden of [
      'gmail.send',
      'gmail.modify',
      'gmail.labels',
      'gmail.compose',
      'https://mail.google.com/',
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });
});

describe('isDeadGrant — stop polling vs back off', () => {
  /**
   * Getting this wrong in either direction is bad, and in opposite ways:
   *
   *   dead treated as transient  -> retries forever, looks healthy, no mail
   *   transient treated as dead  -> a network blip permanently disconnects the user
   */

  it('recognises invalid_grant from the response body', () => {
    expect(isDeadGrant({ response: { data: { error: 'invalid_grant' } } })).toBe(true);
  });

  it('recognises invalid_client', () => {
    expect(isDeadGrant({ response: { data: { error: 'invalid_client' } } })).toBe(true);
  });

  it('recognises it from the message when there is no structured body', () => {
    expect(isDeadGrant(new Error('invalid_grant: Token has been expired or revoked.'))).toBe(true);
    expect(isDeadGrant(new Error('Token has been revoked'))).toBe(true);
  });

  it('does NOT treat a network failure as a dead grant', () => {
    // These must back off and retry. Marking them NEEDS_RECONSENT would
    // disconnect a working mailbox because of a transient blip.
    expect(isDeadGrant(new Error('fetch failed'))).toBe(false);
    expect(isDeadGrant(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(false);
  });

  it('does NOT treat rate limiting as a dead grant', () => {
    expect(isDeadGrant({ response: { data: { error: 'rateLimitExceeded' } } })).toBe(false);
    expect(isDeadGrant(new Error('Quota exceeded for quota metric'))).toBe(false);
  });

  it('handles junk input without throwing', () => {
    expect(isDeadGrant(null)).toBe(false);
    expect(isDeadGrant(undefined)).toBe(false);
    expect(isDeadGrant('invalid_grant')).toBe(false);
  });
});
