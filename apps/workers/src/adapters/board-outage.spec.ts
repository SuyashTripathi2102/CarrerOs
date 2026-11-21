import { EventEmitter } from 'node:events';
import { SourceNotConfiguredError, SourceUnreachableError } from './fetch-failure';

/**
 * The 2026-11-10 incident, replayed against the real adapters: every request
 * fails with EAI_AGAIN (laptop awake, Wi-Fi not yet), and the crawl must fail
 * instead of reporting a successful zero. A source that answers with no rows
 * must still be a zero, and a source with no key must say it is not configured.
 */

const mockHttpsRequest = jest.fn();
const mockHttpsGet = jest.fn();
jest.mock('node:https', () => ({
  request: (...args: unknown[]) => mockHttpsRequest(...args),
  get: (...args: unknown[]) => mockHttpsGet(...args),
}));

import { fetchJoobleJobs } from './jooble';
import { fetchFreehireJobs } from './freehire';
import { fetchAdzunaJobs } from './adzuna';

const ADZUNA_KEY = 'TESTKEY0123456789';
const ADZUNA_QUERIES = 6;

/** A node:https request (Jooble, POST) or get (Adzuna) that fails on the network with `code`. */
function failingRequest(code: string) {
  return () => {
    const handlers: Record<string, (err: Error) => void> = {};
    const req = {
      setTimeout: () => req,
      on: (event: string, fn: (err: Error) => void) => {
        handlers[event] = fn;
        return req;
      },
      write: () => true,
      end: () => undefined,
      destroy: () => undefined,
    };
    setImmediate(() => handlers.error?.(Object.assign(new Error(`getaddrinfo ${code} example.org`), { code })));
    return req;
  };
}

/** A node:https request or get that answers `status` with `body`. */
function answering(status: number, body: unknown) {
  return (...args: unknown[]) => {
    const onResponse = args[args.length - 1] as (res: EventEmitter) => void;
    const req = {
      setTimeout: () => req,
      on: () => req,
      write: () => true,
      end: () => undefined,
      destroy: () => undefined,
    };
    setImmediate(() => {
      const res = Object.assign(new EventEmitter(), {
        statusCode: status,
        setEncoding: () => undefined,
        resume: () => undefined,
      });
      onResponse(res);
      if (status < 400) {
        res.emit('data', JSON.stringify(body));
        res.emit('end');
      }
    });
    return req;
  };
}

const realFetch = global.fetch;
const saved = {
  jooble: process.env.JOOBLE_API_KEY,
  adzunaId: process.env.ADZUNA_APP_ID,
  adzunaKey: process.env.ADZUNA_APP_KEY,
};
let logged: string[];

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  logged = [];
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  process.env.JOOBLE_API_KEY = 'test-key';
  process.env.ADZUNA_APP_ID = 'test-id';
  process.env.ADZUNA_APP_KEY = ADZUNA_KEY;
});
afterEach(() => {
  jest.restoreAllMocks();
  mockHttpsRequest.mockReset();
  mockHttpsGet.mockReset();
  global.fetch = realFetch;
  restore('JOOBLE_API_KEY', saved.jooble);
  restore('ADZUNA_APP_ID', saved.adzunaId);
  restore('ADZUNA_APP_KEY', saved.adzunaKey);
});

describe('Jooble during a network outage', () => {
  it('fails the crawl when every request fails, instead of returning []', async () => {
    mockHttpsRequest.mockImplementation(failingRequest('EAI_AGAIN'));

    const run = fetchJoobleJobs();

    await expect(run).rejects.toBeInstanceOf(SourceUnreachableError);
    await expect(run).rejects.toMatchObject({ kind: 'transient', attempted: 6 });
  });

  it('returns a genuine zero when Jooble answers with no jobs', async () => {
    mockHttpsRequest.mockImplementation(answering(200, { totalCount: 0, jobs: [] }));

    await expect(fetchJoobleJobs()).resolves.toEqual([]);
  });

  it('says it is not configured when JOOBLE_API_KEY is not set, and makes no request', async () => {
    delete process.env.JOOBLE_API_KEY;

    await expect(fetchJoobleJobs()).rejects.toBeInstanceOf(SourceNotConfiguredError);
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });
});

describe('FreeHire during a network outage', () => {
  it('fails the crawl when every request fails, instead of returning []', async () => {
    global.fetch = jest.fn().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'EAI_AGAIN' }) }),
    ) as unknown as typeof fetch;

    const run = fetchFreehireJobs();

    await expect(run).rejects.toBeInstanceOf(SourceUnreachableError);
    await expect(run).rejects.toMatchObject({ kind: 'transient' });
  });

  it('returns a genuine zero when FreeHire answers with no jobs', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [], meta: { total: 0 } }),
    }) as unknown as typeof fetch;

    await expect(fetchFreehireJobs()).resolves.toEqual([]);
  });
});

describe('Adzuna during a network outage', () => {
  it('fails the crawl when every request fails, instead of returning []', async () => {
    mockHttpsGet.mockImplementation(failingRequest('EAI_AGAIN'));

    const run = fetchAdzunaJobs();

    await expect(run).rejects.toBeInstanceOf(SourceUnreachableError);
    await expect(run).rejects.toMatchObject({ kind: 'transient', attempted: ADZUNA_QUERIES });
    expect(mockHttpsGet).toHaveBeenCalledTimes(ADZUNA_QUERIES);
  });

  it('fails as permanent when every request is refused (HTTP 401)', async () => {
    mockHttpsGet.mockImplementation(answering(401, null));

    await expect(fetchAdzunaJobs()).rejects.toMatchObject({ kind: 'permanent', attempted: ADZUNA_QUERIES });
  });

  it('returns a genuine zero when Adzuna answers with no results', async () => {
    mockHttpsGet.mockImplementation(answering(200, { results: [] }));

    await expect(fetchAdzunaJobs()).resolves.toEqual([]);
    expect(mockHttpsGet).toHaveBeenCalledTimes(ADZUNA_QUERIES);
  });

  it('says it is not configured when its id or key is not set, and makes no request', async () => {
    delete process.env.ADZUNA_APP_KEY;

    await expect(fetchAdzunaJobs()).rejects.toBeInstanceOf(SourceNotConfiguredError);
    expect(mockHttpsGet).not.toHaveBeenCalled();
  });

  it('never logs its app_key: not for a network error, an HTTP 403, or the error it throws', async () => {
    mockHttpsGet.mockImplementation(failingRequest('EAI_AGAIN'));
    const outage = await fetchAdzunaJobs().catch((e: unknown) => e);
    mockHttpsGet.mockImplementation(answering(403, null));
    const refused = await fetchAdzunaJobs().catch((e: unknown) => e);

    expect(logged.filter((l) => l.includes('failed')).length).toBeGreaterThan(0);
    expect(logged.join('\n')).not.toContain(ADZUNA_KEY);
    expect(String(outage)).not.toContain(ADZUNA_KEY);
    expect(String(refused)).not.toContain(ADZUNA_KEY);
    // The key really is in the request URL, so the checks above are meaningful.
    expect(String(mockHttpsGet.mock.calls[0][0])).toContain(ADZUNA_KEY);
  });
});
