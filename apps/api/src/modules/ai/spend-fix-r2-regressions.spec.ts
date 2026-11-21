import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { AiUsageService } from './ai-usage.service';
import {
  AiSpendBlockedError,
  parseCreditEnd,
  type SpendEnv,
} from './spend-policy';
import { VertexGeminiProvider } from './vertex-gemini.provider';

// pdf.js cannot start its worker inside Jest: it loads it with a dynamic import, which Jest allows
// only under --experimental-vm-modules. This stand-in reads the uncompressed PDFs these tests build.
// The real pdf.js is run on the same PDFs, on a compressed one and on real resumes by
// run-w3fix-r2.sh, in plain Node, against the compiled production code.
jest.mock('pdf-parse', () => ({
  PDFParse: class {
    private readonly raw: string;
    constructor(opts: { data: Uint8Array }) {
      this.raw = Buffer.from(opts.data).toString('latin1');
    }
    getText() {
      if (!this.raw.startsWith('%PDF-'))
        return Promise.reject(new Error('Invalid PDF structure.'));
      const total = (this.raw.match(/\/Type \/Page /g) ?? []).length;
      const text = Array.from(
        this.raw.matchAll(/\((.*?)\) Tj/g),
        (m) => m[1],
      ).join('\n');
      return Promise.resolve({ total, text, pages: [] });
    }
    destroy() {
      return Promise.resolve();
    }
  },
}));

/**
 * One test per item of the W3 fix round 1 review. Every test uses only what round 1 already had,
 * so this file runs against it unchanged: there, each test is expected to FAIL, which is the
 * demonstration. Against round 2 each one passes.
 *
 * The network tests use Node's real fetch against a local server, so the failures are the ones
 * fetch really produces (a reset, a timeout, a body cut off), not imitations.
 */

const ENV: SpendEnv = {
  AI_DAILY_BUDGET_USD: '1.5',
  AI_INTERACTIVE_RESERVE_USD: '0.25',
  AI_CREDIT_EXPIRES_AT: '2099-01-01',
  AI_DAILY_BUDGET_AFTER_CREDIT_USD: '0',
};
const KEYS = Object.keys(ENV) as (keyof SpendEnv)[];

/** The worst case of generateText('hello'): 2 input tokens at $1.50 and 8,192 output at $9 per million. */
const HELLO_WORST_USD = (2 * 1.5 + 8192 * 9) / 1e6;

/** The real usage service over a fake table that says `spentUsd` was recorded today. */
function usageService(spentUsd: number) {
  const rows: {
    costUsd: number | null;
    errorCode?: string;
    inputTokens?: number;
    ok: boolean;
  }[] = [];
  const prisma = {
    aiUsage: {
      aggregate: () => Promise.resolve({ _sum: { costUsd: spentUsd } }),
      create: (args: { data: (typeof rows)[number] }) => {
        rows.push(args.data);
        return Promise.resolve({});
      },
    },
  };
  return { usage: new AiUsageService(prisma as never), rows };
}
const charged = (rows: { costUsd: number | null }[]) =>
  rows.reduce((n, r) => n + Number(r.costUsd ?? 0), 0);

/** The real Vertex provider. */
function vertex(usage: AiUsageService, settings: Record<string, string> = {}) {
  const values: Record<string, string> = {
    GOOGLE_CLOUD_PROJECT: 'project',
    ...settings,
  };
  const provider = new VertexGeminiProvider(
    { get: (k: string) => values[k] } as never,
    usage,
  );
  Object.assign(provider, {
    auth: { getAccessToken: () => Promise.resolve('token') },
  });
  return provider;
}

/** A valid PDF of `pages` pages, each with one line of text. */
function pdf(pages: number): Buffer {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 12 Tf 72 720 Td (Experience ${i + 1}) Tj ET`;
    objs[4 + 2 * i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
    objs[5 + 2 * i] =
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  out += offsets
    .slice(1)
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('');
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const answer = (json: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(json) });

describe('W3 fix round 2 regressions', () => {
  const realFetch = global.fetch;
  const saved: Partial<Record<keyof SpendEnv, string>> = {};
  let server: Server;
  let base = '';
  let requests = 0;
  let handle: (req: IncomingMessage, res: ServerResponse) => void = () =>
    undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests++;
        handle(req, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  beforeEach(() => {
    requests = 0;
    for (const k of KEYS) {
      saved[k] = process.env[k];
      process.env[k] = ENV[k];
    }
  });
  afterEach(() => {
    global.fetch = realFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.restoreAllMocks();
  });

  /** Real fetch, sent to the local server instead of Google. */
  const viaLocalServer = () => {
    global.fetch = (_: unknown, init?: RequestInit) => realFetch(base, init);
  };

  describe('1. F1: offsets beyond ±14:00 are refused', () => {
    it('refuses +14:01 and -14:59', () => {
      expect(parseCreditEnd('2026-11-25T00:00+14:01')).toBeNull();
      expect(parseCreditEnd('2026-11-25T00:00-14:59')).toBeNull();
    });
  });

  describe('2. F5: a request Google may have billed without an answer is charged', () => {
    it('charges the worst case when the connection is closed after the request was sent', async () => {
      const { usage, rows } = usageService(0);
      handle = (req) => req.socket.destroy();
      viaLocalServer();

      await expect(vertex(usage).generateText('hello')).rejects.toThrow();

      expect(charged(rows)).toBeCloseTo(HELLO_WORST_USD, 9);
    });

    it('charges the worst case when no answer comes before the timeout', async () => {
      const { usage, rows } = usageService(0);
      // No answer; the connection is dropped after 1.5 s so that code without a timeout ends too.
      handle = (req) =>
        void setTimeout(() => req.socket.destroy(), 1_500).unref();
      viaLocalServer();

      await expect(
        vertex(usage, { AI_REQUEST_TIMEOUT_MS: '200' }).generateText('hello'),
      ).rejects.toThrow();

      expect(rows.map((r) => r.errorCode)).toContain('unconfirmed_timeout');
      expect(charged(rows)).toBeCloseTo(HELLO_WORST_USD, 9);
    });

    it('charges the worst case when a 200 arrives and its body is cut off', async () => {
      const { usage, rows } = usageService(0);
      handle = (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"candidates":');
        setTimeout(() => req.socket.destroy(), 50).unref();
      };
      viaLocalServer();

      await expect(vertex(usage).generateText('hello')).rejects.toThrow();

      expect(charged(rows)).toBeCloseTo(HELLO_WORST_USD, 9);
    });

    it('charges a 5xx attempt, so a retry needs room for another worst case', async () => {
      // $1.17 spent: room under $1.25 for one worst case of $0.074, not two.
      const { usage } = usageService(1.17);
      handle = (_req, res) =>
        requests === 1
          ? res.writeHead(503).end('busy')
          : res.writeHead(200, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                candidates: [{ content: { parts: [{ text: 'hi' }] } }],
                usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
              }),
            );
      viaLocalServer();

      await expect(vertex(usage).generateText('hello')).rejects.toBeInstanceOf(
        AiSpendBlockedError,
      );

      expect(requests).toBe(1);
    }, 30_000); // round 1 waits out the 5-second backoff before it fails on the count

    it('records a 200 with an empty answer at the tokens Google counted', async () => {
      const { usage, rows } = usageService(0);
      global.fetch = jest.fn(() =>
        answer({
          candidates: [{ content: { parts: [] } }],
          usageMetadata: { promptTokenCount: 1000, thoughtsTokenCount: 8192 },
        }),
      ) as never;

      await expect(vertex(usage).generateText('hello')).rejects.toThrow(
        'empty response',
      );

      expect(charged(rows)).toBeCloseTo((1000 * 1.5 + 8192 * 9) / 1e6, 9);
    });

    it('records a 200 that reported no token counts at the worst case', async () => {
      const { usage, rows } = usageService(0);
      global.fetch = jest.fn(() =>
        answer({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }),
      ) as never;

      await vertex(usage).generateText('hello');

      expect(charged(rows)).toBeCloseTo(HELLO_WORST_USD, 9);
    });

    it('charges an embedding request whose connection was closed, as well as the ones answered', async () => {
      const { usage, rows } = usageService(0);
      handle = (req, res) =>
        requests === 1
          ? res.writeHead(200, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                predictions: [{ embeddings: { values: [0.1] } }],
              }),
            )
          : req.socket.destroy();
      viaLocalServer();

      await expect(
        vertex(usage, { VERTEX_EMBED_BATCH_SIZE: '1' }).embed([
          'a'.repeat(400),
          'b'.repeat(400),
        ]),
      ).rejects.toThrow();

      // Two requests of 100 tokens each went out; both may be billed.
      expect(rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0)).toBe(200);
    });
  });

  describe('3. F5: an attached file is reserved for what it may really cost', () => {
    it('reserves at least 1,120 tokens a page for a 40-page PDF', async () => {
      const { usage } = usageService(0);
      const admit = jest.spyOn(usage, 'admit');
      global.fetch = jest.fn(() =>
        answer({
          candidates: [{ content: { parts: [{ text: 'hi' }] } }],
          usageMetadata: { promptTokenCount: 30_000, candidatesTokenCount: 1 },
        }),
      ) as never;

      await vertex(usage).generateText('Read this resume.', {
        files: [{ mimeType: 'application/pdf', data: pdf(40) }],
      });

      expect(admit.mock.calls[0][0].inputTokens).toBeGreaterThanOrEqual(
        40 * 1_120,
      );
    });

    it('refuses a file type it has no estimate for, before any request', async () => {
      const { usage } = usageService(0);
      const fetchMock = jest.fn(() =>
        answer({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }),
      );
      global.fetch = fetchMock as never;

      await expect(
        vertex(usage).generateText('Read this.', {
          files: [{ mimeType: 'image/png', data: Buffer.from('png') }],
        }),
      ).rejects.toBeInstanceOf(AiSpendBlockedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a PDF whose pages cannot be counted, before any request', async () => {
      const { usage } = usageService(0);
      const fetchMock = jest.fn(() =>
        answer({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }),
      );
      global.fetch = fetchMock as never;

      await expect(
        vertex(usage).generateText('Read this.', {
          files: [
            { mimeType: 'application/pdf', data: Buffer.from('not a pdf') },
          ],
        }),
      ).rejects.toBeInstanceOf(AiSpendBlockedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
