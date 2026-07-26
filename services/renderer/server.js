'use strict';

/**
 * CareerOS render service (Phase 4).
 *
 * A tiny HTTP server that loads a URL in a real Chromium and returns the
 * rendered HTML. It does exactly one thing — turn a JS app shell into DOM the
 * deterministic extractor can read — and nothing else: no extraction, no
 * parsing, no DB. That logic lives in the workers and stays identical whether
 * the HTML came from a static fetch or from here. "Just another renderer."
 *
 * Deploy on its own box (Chromium needs the RAM the 2 GB API box doesn't have),
 * then set RENDER_SERVICE_URL on the workers to this service's URL.
 *
 * POST /render { url, waitUntil? } -> { html, status, finalUrl }
 * GET  /health                     -> { ok: true, pages: <in-flight> }
 */

const http = require('http');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 4000);
const TOKEN = process.env.RENDER_SERVICE_TOKEN || null;
const MAX_CONCURRENCY = Number(process.env.RENDER_MAX_CONCURRENCY || 2);
const NAV_TIMEOUT_MS = Number(process.env.RENDER_NAV_TIMEOUT_MS || 30000);
const SETTLE_MS = Number(process.env.RENDER_SETTLE_MS || 1200); // let late XHR-driven lists paint

let browserPromise = null;
let inFlight = 0;

/** One shared browser, launched lazily and reused across requests. */
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  return browserPromise;
}

async function render(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; CareerOS-Renderer/0.1)',
    viewport: { width: 1280, height: 2000 },
    javaScriptEnabled: true,
  });
  const page = await context.newPage();
  // Skip images/fonts/media — we only need the DOM, and this cuts render time
  // and bandwidth substantially on heavy marketing career pages.
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    const html = await page.content();
    return { html, status: resp ? resp.status() : 0, finalUrl: page.url() };
  } finally {
    await context.close().catch(() => {});
  }
}

function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, pages: inFlight });
  }
  if (req.method !== 'POST' || req.url !== '/render') {
    return send(res, 404, { error: 'not found' });
  }
  if (TOKEN && req.headers['x-render-token'] !== TOKEN) {
    return send(res, 401, { error: 'unauthorized' });
  }
  if (inFlight >= MAX_CONCURRENCY) {
    return send(res, 429, { error: 'busy' });
  }

  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 100_000) req.destroy(); // tiny request; anything larger is abuse
  });
  req.on('end', async () => {
    let url;
    try {
      url = JSON.parse(raw).url;
      new URL(url); // validate
    } catch {
      return send(res, 400, { error: 'invalid url' });
    }
    inFlight++;
    try {
      const out = await render(url);
      send(res, 200, out);
    } catch (err) {
      send(res, 502, { error: String((err && err.message) || err).slice(0, 300) });
    } finally {
      inFlight--;
    }
  });
});

server.listen(PORT, () => console.log(`[renderer] listening on :${PORT} (concurrency ${MAX_CONCURRENCY})`));

const shutdown = async () => {
  server.close();
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b) await b.close().catch(() => {});
  }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
