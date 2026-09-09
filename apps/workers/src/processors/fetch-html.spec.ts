import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import type { Socket } from 'net';
import { fetchHtmlV4 } from './extract-career-pages.processor';

/**
 * The fetcher's contract is one sentence: it ALWAYS settles.
 *
 * That is not pedantry. `req.destroy()` with no argument aborts a socket without
 * emitting 'error', so the timeout and body-cap paths used to leave the promise
 * pending forever. In the worker that produces no crash, no error and no log —
 * the job holds its concurrency slot until the BullMQ lock expires and the queue
 * wedges. It was found when a standalone script using this exact fetcher exited
 * cleanly with code 0 after 3 of 36 URLs, having simply run out of event loop.
 *
 * These use real sockets on purpose. The defect lives in Node's socket teardown
 * semantics; a mocked http module would faithfully reproduce the assumption that
 * was wrong in the first place and pass against the broken version.
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

describe('fetchHtmlV4 — always settles', () => {
  it('REGRESSION: settles on the hard deadline when the socket timeout never fires', async () => {
    // THE test. req.setTimeout is socket-inactivity only — it arms once a socket
    // is assigned and so covers nothing during DNS/connect. A host stalling
    // before the socket exists is invisible to it (auxano.zohorecruit.in did not
    // settle inside 15s while holding a 10s socket timeout).
    //
    // A huge socket timeout with a small deadline isolates that path: only the
    // overall deadline can settle this. Without it the promise waits 60s and the
    // test times out — which is precisely how it failed in production, silently.
    await listen(() => {
      /* accept, never respond */
    });
    const started = Date.now();
    const html = await fetchHtmlV4(`${base}/careers`, 60_000, 400);
    expect(html).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('the deadline keeps the event loop alive while a fetch is outstanding', async () => {
    // The timer is deliberately not unref'd. An unref'd timer would let the
    // process drain and exit 0 mid-run, which is how this was found: a script
    // using this fetcher "finished successfully" after 3 of 36 URLs.
    await listen(() => {
      /* accept, never respond */
    });
    const p = fetchHtmlV4(`${base}/careers`, 60_000, 300);
    await expect(p).resolves.toBeNull();
  }, 10_000);

  it('REGRESSION: a server that accepts and never responds resolves, not hangs', async () => {
    // The original defect. Before the fix this promise never settled and the
    // test times out rather than failing an assertion — which is exactly how it
    // behaved in production: no error, just a job that never came back.
    await listen(() => {
      /* accept the connection, send nothing, ever */
    });
    const started = Date.now();
    const html = await fetchHtmlV4(`${base}/careers`, 300);
    expect(html).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it('REGRESSION: a socket destroyed by the peer mid-request resolves', async () => {
    await listen((req) => req.socket.destroy());
    const html = await fetchHtmlV4(`${base}/careers`, 2_000);
    expect(html).toBeNull();
  }, 10_000);

  it('REGRESSION: a response cut off mid-body resolves instead of waiting for an end that never comes', async () => {
    await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '9999' });
      res.write('<html><body>partial');
      res.socket?.destroy(); // no 'end', no 'error'
    });
    const html = await fetchHtmlV4(`${base}/careers`, 2_000);
    expect(html === null || html.includes('partial')).toBe(true);
  }, 10_000);

  it('returns the body on a normal 200', async () => {
    await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><a href="/jobs/1">Backend Engineer</a></body></html>');
    });
    await expect(fetchHtmlV4(`${base}/careers`, 2_000)).resolves.toContain('Backend Engineer');
  }, 10_000);

  it('follows one redirect', async () => {
    await listen((req, res) => {
      if (req.url === '/careers') {
        res.writeHead(302, { location: '/jobs' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>redirected</html>');
    });
    await expect(fetchHtmlV4(`${base}/careers`, 2_000)).resolves.toContain('redirected');
  }, 10_000);

  it('resolves null on 404 rather than throwing', async () => {
    await listen((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('nope');
    });
    await expect(fetchHtmlV4(`${base}/careers`, 2_000)).resolves.toBeNull();
  }, 10_000);

  it('resolves null for non-HTML content', async () => {
    // A PDF or JSON career page is not something the deterministic extractor
    // can read, and pretending otherwise wastes a parse.
    await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.4');
    });
    await expect(fetchHtmlV4(`${base}/careers`, 2_000)).resolves.toBeNull();
  }, 10_000);

  it('resolves null for a malformed URL without throwing', async () => {
    await expect(fetchHtmlV4('not a url', 500)).resolves.toBeNull();
  });

  it('resolves null when nothing is listening', async () => {
    // Port 1 on loopback: connection refused, which DOES emit 'error'. Kept so
    // the ordinary failure path stays covered alongside the silent ones.
    await expect(fetchHtmlV4('http://127.0.0.1:1/careers', 1_000)).resolves.toBeNull();
  }, 10_000);
});
