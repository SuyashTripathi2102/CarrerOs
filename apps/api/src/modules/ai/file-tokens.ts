import { PDFParse } from 'pdf-parse';
import type { FilePart } from './llm.provider';
import { AiSpendBlockedError } from './spend-policy';

/**
 * Input tokens a PDF page may cost. Gemini 3 bills each page of a PDF as an image: 560 tokens at
 * the default media resolution, which CareerOS's requests use (they set none), and 1,120 at the
 * highest level documented for PDFs (MEDIA_RESOLUTION_HIGH). The reservation takes the highest.
 */
export const PDF_TOKENS_PER_PAGE = 1_120;

/**
 * Input tokens the attached files may cost, counted from the files themselves before anything is
 * sent, for the worst case a request reserves (estimatedInputTokens, AiUsageService.admit).
 *
 * PDF is the only type CareerOS attaches: the resume vision fallback, and uploads accept PDF only.
 * A PDF costs at most PDF_TOKENS_PER_PAGE per page, plus the text embedded in it, which Gemini
 * also gives the model. The Gemini API documents that text as not billed; Vertex does not say, so
 * it is reserved too, at one token per UTF-8 byte of the text pdf.js extracts (a token is never
 * shorter than a byte).
 *
 * Any other type, or a PDF whose pages cannot be counted, is refused before anything is sent: its
 * cost could not be bounded, like a model with no price.
 */
export async function fileInputTokens(
  files: readonly FilePart[] | undefined,
): Promise<number> {
  let tokens = 0;
  for (const file of files ?? []) tokens += await oneFile(file);
  return tokens;
}

async function oneFile(file: FilePart): Promise<number> {
  if (file.mimeType !== 'application/pdf') {
    throw new AiSpendBlockedError(
      `an attached file of type "${file.mimeType}" has no token estimate (only application/pdf has), so its cost could not be counted against the daily budget; not sent`,
    );
  }
  let pages = 0;
  let textBytes = 0;
  const parser = new PDFParse({ data: new Uint8Array(file.data) });
  try {
    const result = await parser.getText();
    pages = result.total;
    textBytes = Buffer.byteLength(result.text ?? '', 'utf8');
  } catch {
    pages = 0;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  if (!Number.isInteger(pages) || pages < 1) {
    throw new AiSpendBlockedError(
      'the attached PDF could not be read to count its pages, so its cost could not be counted against the daily budget; not sent',
    );
  }
  return pages * PDF_TOKENS_PER_PAGE + textBytes;
}
