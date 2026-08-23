import { isTransportFault, installProcessGuard } from './process-guard';

/**
 * The rule pinned here: a fault that came off a socket must not kill the
 * process; a fault in our own code still must.
 */
describe('isTransportFault', () => {
  it('recognises the undici parser assertion that killed the workers', () => {
    // Verbatim shape of the 2026-08-23 crash: a bare assertion with no code of
    // its own beyond ERR_ASSERTION, identifiable only by its frames.
    const err = Object.assign(new Error('false == true'), {
      code: 'ERR_ASSERTION',
      stack:
        'AssertionError [ERR_ASSERTION]: false == true\n' +
        '    at Parser.finish (node:internal/deps/undici/undici:7388:9)\n' +
        '    at TLSSocket.onHttpSocketEnd (node:internal/deps/undici/undici:7827:34)',
    });
    expect(isTransportFault(err)).toBe(true);
  });

  it('does NOT treat an assertion in our own code as a transport fault', () => {
    // The whole point of scoping to undici frames. A real invariant violation
    // must still crash loudly rather than be swallowed as network noise.
    const err = Object.assign(new Error('expected 1 board, got 0'), {
      code: 'ERR_ASSERTION',
      stack: 'AssertionError\n    at crawlBoard (/CarrerOs/apps/workers/src/x.ts:10:1)',
    });
    expect(isTransportFault(err)).toBe(false);
  });

  it('recognises ordinary socket failures', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_BODY_TIMEOUT']) {
      expect(isTransportFault(Object.assign(new Error(code), { code }))).toBe(true);
    }
  });

  it('unwraps the cause behind a bare "fetch failed"', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });
    expect(isTransportFault(err)).toBe(true);
  });

  it('is not fooled by a self-referential cause', () => {
    const err = new Error('boom') as Error & { cause?: unknown };
    err.cause = err;
    expect(isTransportFault(err)).toBe(false);
  });

  it('rejects non-objects and plain application errors', () => {
    expect(isTransportFault(null)).toBe(false);
    expect(isTransportFault('ECONNRESET')).toBe(false);
    expect(isTransportFault(new Error('company not found'))).toBe(false);
  });
});

describe('installProcessGuard', () => {
  const listeners = () => [
    ...process.listeners('uncaughtException'),
    ...process.listeners('unhandledRejection'),
  ];
  let before: unknown[];

  beforeEach(() => {
    before = listeners();
  });
  afterEach(() => {
    for (const l of listeners()) {
      if (!before.includes(l)) {
        process.off('uncaughtException', l as never);
        process.off('unhandledRejection', l as never);
      }
    }
  });

  it('survives a transport fault and exits on anything else', () => {
    const log = { error: jest.fn() };
    const exit = jest.fn();
    installProcessGuard(log, exit as never);

    process.emit(
      'uncaughtException',
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    expect(exit).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('transport fault survived'));

    process.emit('uncaughtException', new TypeError('x.map is not a function'));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
