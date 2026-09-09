import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import type { Socket } from 'net';
import { hydrateDescriptions, describeHydration } from './hydrate-descriptions.processor';
import type { ApiClient } from '../api-client';

/**
 * These pin what the processor may and may not write.
 *
 * The bug it exists to fix was a manufactured description, so the tests that
 * matter are the ones proving it cannot manufacture another one, cannot write
 * on a failed fetch, and cannot replace a good body with a worse one.
 */

let server: Server;
let sockets: Socket[] = [];
let base = '';

function listen(handler: Parameters<typeof createServer>[1]): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.on('connection', (s) => sockets.push(s));
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets = [];
  if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
});

const POSTING = `<html><body><h1>Backend Engineer</h1>
  <h2>Responsibilities</h2><p>You will build and operate backend services in Go,
  owning them end to end. Experience with distributed systems is expected and
  you will be on call for what you ship.</p>
  <h2>Requirements</h2><p>2+ years writing production code.</p></body></html>`;

const STUB = 'Backend Engineer · Bengaluru — via Acme careers page.';

function fakeApi(due: any[], captured: any[]): ApiClient {
  return {
    hydrationDue: async () => due,
    repairDescriptions: async (source: string, updates: any[]) => {
      captured.push({ source, updates });
      return { matched: updates.length, changed: updates.length, unchanged: 0, notFound: 0 };
    },
  } as unknown as ApiClient;
}

describe('hydrateDescriptions', () => {
  it('recovers a real description and labels it DETAIL', async () => {
    await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(POSTING);
    });
    const captured: any[] = [];
    const api = fakeApi(
      [{ id: '1', externalId: 'x1', source: 'career-page-deterministic-v1', url: `${base}/jobs/1`, description: STUB }],
      captured,
    );

    const out = await hydrateDescriptions(api, 10);
    expect(out.written).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0].source).toBe('career-page-deterministic-v1');
    expect(captured[0].updates[0].descriptionSource).toBe('DETAIL');
    expect(captured[0].updates[0].description).toContain('Responsibilities');
  }, 15_000);

  it('NEVER writes the synthetic stub back', async () => {
    await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(POSTING);
    });
    const captured: any[] = [];
    const out = await hydrateDescriptions(
      fakeApi([{ id: '1', externalId: 'x1', source: 's', url: `${base}/1`, description: STUB }], captured),
      10,
    );
    expect(out.written).toBe(1);
    expect(captured[0].updates[0].description).not.toContain('via Acme careers page');
  }, 15_000);

  it('writes NOTHING when the fetch fails', async () => {
    // A timeout must never become a stored fact.
    const captured: any[] = [];
    const out = await hydrateDescriptions(
      fakeApi(
        [{ id: '1', externalId: 'x1', source: 's', url: 'http://127.0.0.1:1/nope', description: STUB }],
        captured,
      ),
      10,
    );
    expect(out.fetchFailed).toBe(1);
    expect(out.written).toBe(0);
    expect(captured).toHaveLength(0);
  }, 20_000);

  it('writes NOTHING when the detail page carries no posting', async () => {
    await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body><p>${'We build delightful products. '.repeat(30)}</p></body></html>`);
    });
    const captured: any[] = [];
    const out = await hydrateDescriptions(
      fakeApi([{ id: '1', externalId: 'x1', source: 's', url: `${base}/1`, description: STUB }], captured),
      10,
    );
    expect(out.written).toBe(0);
    expect(out.kept).toBe(1);
    expect(captured).toHaveLength(0);
  }, 15_000);

  it('does not replace a richer stored body with a thinner page', async () => {
    await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(POSTING);
    });
    const rich = `About the role. ${'Detailed responsibilities and requirements follow. '.repeat(40)}`;
    const captured: any[] = [];
    const out = await hydrateDescriptions(
      fakeApi([{ id: '1', externalId: 'x1', source: 's', url: `${base}/1`, description: rich }], captured),
      10,
    );
    expect(out.written).toBe(0);
    expect(captured).toHaveLength(0);
  }, 15_000);

  it('groups writes by source — repairDescriptions matches on (source, externalId)', async () => {
    await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(POSTING);
    });
    const captured: any[] = [];
    await hydrateDescriptions(
      fakeApi(
        [
          { id: '1', externalId: 'a', source: 'career-page-deterministic-v1', url: `${base}/1`, description: STUB },
          { id: '2', externalId: 'b', source: 'lever', url: `${base}/2`, description: STUB },
          { id: '3', externalId: 'c', source: 'lever', url: `${base}/3`, description: STUB },
        ],
        captured,
      ),
      10,
    );
    const bySource = Object.fromEntries(captured.map((c) => [c.source, c.updates.length]));
    expect(bySource).toEqual({ 'career-page-deterministic-v1': 1, lever: 2 });
  }, 25_000);

  it('creates no jobs and calls no other write path', async () => {
    await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(POSTING);
    });
    const captured: any[] = [];
    const api = fakeApi([{ id: '1', externalId: 'x', source: 's', url: `${base}/1`, description: STUB }], captured);
    // Any other client method being reachable would throw, since the fake
    // defines only the two this processor is allowed to use.
    await expect(hydrateDescriptions(api, 10)).resolves.toBeDefined();
  }, 15_000);
});

describe('describeHydration — zero is a reading', () => {
  it('flags fetched-pages-but-recovered-nothing', () => {
    const msg = describeHydration({ attempted: 20, fetched: 20, written: 0, kept: 20, fetchFailed: 0, bySource: {} });
    expect(msg).toMatch(/RECOVERED NOTHING/);
  });

  it('says nothing alarming about a normal run', () => {
    const msg = describeHydration({ attempted: 20, fetched: 20, written: 17, kept: 3, fetchFailed: 0, bySource: {} });
    expect(msg).not.toMatch(/RECOVERED NOTHING/);
  });

  it('does not flag a run that fetched nothing at all', () => {
    const msg = describeHydration({ attempted: 0, fetched: 0, written: 0, kept: 0, fetchFailed: 0, bySource: {} });
    expect(msg).not.toMatch(/RECOVERED NOTHING/);
  });
});
