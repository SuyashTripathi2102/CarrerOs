import {
  describeFetchError,
  FetchTally,
  SourceNotConfiguredError,
  SourceUnreachableError,
} from './fetch-failure';

const netError = (code: string) =>
  Object.assign(new Error(`getaddrinfo ${code} example.org`), { code });
const undiciError = (code: string) =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('x'), { code }),
  });

describe('describeFetchError', () => {
  it.each([
    [
      'DNS not ready after wake (node:https)',
      netError('EAI_AGAIN'),
      'EAI_AGAIN',
    ],
    ['DNS not ready after wake (fetch)', undiciError('EAI_AGAIN'), 'EAI_AGAIN'],
    ['connection refused', undiciError('ECONNREFUSED'), 'ECONNREFUSED'],
    [
      'connect timeout',
      undiciError('UND_ERR_CONNECT_TIMEOUT'),
      'UND_ERR_CONNECT_TIMEOUT',
    ],
  ])('treats %s as transient', (_label, err, code) => {
    expect(describeFetchError(err)).toEqual({ kind: 'transient', code });
  });

  it('treats a bare "fetch failed" and a request timeout as transient', () => {
    expect(describeFetchError(new TypeError('fetch failed')).kind).toBe(
      'transient',
    );
    expect(describeFetchError(new Error('timeout')).kind).toBe('transient');
  });

  it.each([
    ['GET https://x.test/a -> 503', 'transient', 'HTTP 503'],
    ['GET -> 500', 'transient', 'HTTP 500'],
    ['POST -> 408', 'transient', 'HTTP 408'],
    ['POST -> 429', 'transient', 'HTTP 429'],
    ['GET https://x.test/a -> 429', 'transient', 'HTTP 429'],
    ['POST -> 401', 'permanent', 'HTTP 401'],
    ['GET -> 403', 'permanent', 'HTTP 403'],
    ['GET -> 404', 'permanent', 'HTTP 404'],
    ['POST -> 400', 'permanent', 'HTTP 400'],
    ['POST -> 422', 'permanent', 'HTTP 422'],
  ])('classifies "%s" as %s', (message, kind, code) => {
    expect(describeFetchError(new Error(message))).toEqual({ kind, code });
  });

  it('treats an unparseable body as permanent', () => {
    expect(describeFetchError(new SyntaxError('Unexpected token <'))).toEqual({
      kind: 'permanent',
      code: 'invalid JSON',
    });
  });

  it('never returns the raw message, which can carry a keyed URL', () => {
    const { code } = describeFetchError(
      new Error('GET https://api.test/search?app_key=SECRET123 -> 403'),
    );
    expect(code).toBe('HTTP 403');
    expect(code).not.toContain('SECRET123');
  });
});

describe('FetchTally', () => {
  it('stays quiet when at least one request succeeded, even if it returned nothing', () => {
    const t = new FetchTally();
    t.failedWith(netError('EAI_AGAIN'));
    t.succeeded();
    expect(() => t.assertReachable('jooble')).not.toThrow();
  });

  it('stays quiet when no request was made', () => {
    expect(() => new FetchTally().assertReachable('adzuna')).not.toThrow();
  });

  it('counts a crawl whose every request was rate limited (429) as transient, so it is retried', () => {
    const t = new FetchTally();
    for (let i = 0; i < 3; i++) t.failedWith(new Error('POST -> 429'));
    expect(() => t.assertReachable('jooble')).toThrow(
      expect.objectContaining({
        kind: 'transient',
        message: 'jooble: all 3 requests failed (HTTP 429 ×3)',
      }),
    );
  });

  it('throws a transient SourceUnreachableError when every request failed on the network', () => {
    const t = new FetchTally();
    for (let i = 0; i < 6; i++) t.failedWith(undiciError('EAI_AGAIN'));
    let thrown: unknown;
    try {
      t.assertReachable('freehire');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SourceUnreachableError);
    expect((thrown as SourceUnreachableError).kind).toBe('transient');
    expect((thrown as SourceUnreachableError).message).toBe(
      'freehire: all 6 requests failed (EAI_AGAIN ×6)',
    );
  });

  it('is permanent only when no failure was transient; mixed failures count as transient', () => {
    const t = new FetchTally();
    t.failedWith(new Error('POST -> 401'));
    t.failedWith(new Error('POST -> 401'));
    expect(() => t.assertReachable('jooble')).toThrow(
      expect.objectContaining({ kind: 'permanent' }),
    );

    const mixed = new FetchTally();
    mixed.failedWith(new Error('POST -> 401'));
    mixed.failedWith(netError('ETIMEDOUT'));
    expect(() => mixed.assertReachable('jooble')).toThrow(
      expect.objectContaining({ kind: 'transient' }),
    );
  });
});

describe('SourceNotConfiguredError', () => {
  it('names the missing setting, never a value', () => {
    const err = new SourceNotConfiguredError(
      'adzuna',
      'ADZUNA_APP_ID/ADZUNA_APP_KEY',
    );

    expect(err.message).toBe(
      'adzuna: not configured (ADZUNA_APP_ID/ADZUNA_APP_KEY not set)',
    );
    expect(err).toMatchObject({
      name: 'SourceNotConfiguredError',
      source: 'adzuna',
    });
    expect(err).not.toBeInstanceOf(SourceUnreachableError);
  });
});
