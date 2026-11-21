import { fileInputTokens, PDF_TOKENS_PER_PAGE } from './file-tokens';
import { AiSpendBlockedError } from './spend-policy';

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

/** A valid PDF of `pages` pages, each with one line of text. */
function pdf(pages: number, line = 'Experience'): Buffer {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 12 Tf 72 720 Td (${line} ${i + 1}) Tj ET`;
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

const asPdf = (data: Buffer) => ({ mimeType: 'application/pdf', data });

describe('fileInputTokens: what attached files may cost, counted from the files', () => {
  it('reserves the highest per-page level Gemini 3 documents for PDFs, twice the default of 560', () => {
    expect(PDF_TOKENS_PER_PAGE).toBe(1_120);
  });

  it.each([1, 3, 40])(
    'counts every page of a %i-page PDF, plus its embedded text',
    async (pages) => {
      const tokens = await fileInputTokens([asPdf(pdf(pages))]);

      expect(tokens).toBeGreaterThanOrEqual(pages * PDF_TOKENS_PER_PAGE);
      // The text part is at most one token per byte of the text pdf.js extracts: a few bytes a page here.
      expect(tokens - pages * PDF_TOKENS_PER_PAGE).toBeGreaterThan(0);
      expect(tokens - pages * PDF_TOKENS_PER_PAGE).toBeLessThan(pages * 40);
    },
  );

  it('covers a 40-page PDF that the old flat 20,000 tokens a file did not', async () => {
    expect(await fileInputTokens([asPdf(pdf(40))])).toBeGreaterThan(20_000);
  });

  it('adds up several files, and is 0 with none', async () => {
    const one = await fileInputTokens([asPdf(pdf(1))]);
    const two = await fileInputTokens([asPdf(pdf(2))]);

    expect(await fileInputTokens([asPdf(pdf(1)), asPdf(pdf(2))])).toBe(
      one + two,
    );
    expect(await fileInputTokens([])).toBe(0);
    expect(await fileInputTokens(undefined)).toBe(0);
  });

  it('refuses a type it has no estimate for, before reading it', async () => {
    await expect(
      fileInputTokens([{ mimeType: 'image/png', data: Buffer.from('png') }]),
    ).rejects.toThrow('no token estimate');
  });

  it('refuses a PDF whose pages cannot be counted', async () => {
    await expect(
      fileInputTokens([asPdf(Buffer.from('not a pdf'))]),
    ).rejects.toBeInstanceOf(AiSpendBlockedError);
  });
});
