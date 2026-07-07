/**
 * Provider-agnostic AI contracts. Features depend on THESE, never on a vendor
 * SDK — switching vendors is a config change, not a refactor.
 *
 * Two independent tokens because the two workloads have independent markets:
 * embeddings (bulk, commodity-priced) and text generation (scoring, parsing).
 * LLM_PROVIDER / EMBEDDING_PROVIDER env vars select each; both fall back to
 * AI_PROVIDER, so a single-vendor setup stays a one-line config.
 */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

export interface FilePart {
  mimeType: string; // e.g. "application/pdf"
  data: Buffer;
}

export interface GenerateOptions {
  system?: string;
  /** Attach files (PDFs, images) for multimodal models. */
  files?: FilePart[];
  maxOutputTokens?: number;
  temperature?: number;
}

export interface LlmProvider {
  /** Free-form text generation. */
  generateText(prompt: string, opts?: GenerateOptions): Promise<string>;

  /** JSON-mode generation, parsed and typed by the caller. */
  generateJson<T>(prompt: string, opts?: GenerateOptions): Promise<T>;
}

export interface EmbeddingProvider {
  /** Batch embeddings — dimensionality fixed by EMBEDDING_DIMS (pgvector schema). */
  embed(texts: string[]): Promise<number[][]>;
}
