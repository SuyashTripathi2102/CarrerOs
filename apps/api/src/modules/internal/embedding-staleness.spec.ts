/**
 * THE EMBEDDING INVARIANT (2026-08-23).
 *
 * A job's vector is built from title + description. When the description
 * changes the vector is stale, and NOTHING refreshes it on its own:
 *
 *   embedJobsByIds   where: { id: { in: jobIds }, embedding: null }
 *   INSERT ...       ON CONFLICT ("jobId") DO NOTHING
 *
 * Both refuse to touch a job that already has a vector. So a stale one survives
 * forever, silently, and it corrupts RETRIEVAL — which gates judging. The right
 * job can be invisible to the very query meant to find it.
 *
 * Hit directly by the description repair: 5,270 jobs ended up with correct text
 * and vectors built from an EMPTY body.
 *
 * The rule pinned here: a changed description MUST invalidate the vector, and
 * an unchanged one must NOT (re-embedding every job on every crawl would be
 * both expensive and pointless).
 */

/** Mirrors the decision made from the upsert's RETURNING clause. */
function shouldClearEmbedding(row: { inserted: boolean; description_changed: boolean }): boolean {
  return !row.inserted && row.description_changed;
}

describe('a changed description invalidates the embedding', () => {
  it('clears the vector when an existing job\'s body changes', () => {
    expect(shouldClearEmbedding({ inserted: false, description_changed: true })).toBe(true);
  });

  it('does NOT clear when the body is unchanged', () => {
    // Every crawl re-upserts every posting. Clearing unconditionally would
    // re-embed the whole corpus on every tick.
    expect(shouldClearEmbedding({ inserted: false, description_changed: false })).toBe(false);
  });

  it('does NOT clear for a newly inserted job', () => {
    // A new job has no vector to invalidate; it is enqueued as new instead.
    expect(shouldClearEmbedding({ inserted: true, description_changed: false })).toBe(false);
  });
});

describe('why deletion is the mechanism, not an update', () => {
  /** Mirrors embedJobsByIds' filter and the insert's conflict clause. */
  const embedderWouldTouch = (hasVector: boolean) => !hasVector;

  it('the embedder skips any job that already has a vector', () => {
    expect(embedderWouldTouch(true)).toBe(false);
    expect(embedderWouldTouch(false)).toBe(true);
  });

  it('so clearing the row is what makes the existing path rebuild it', () => {
    // This is the whole reason the invariant deletes rather than marks: with
    // `embedding: null` the job re-enters the embed queue's own selection.
    const hadVector = true;
    const afterInvalidation = false; // row deleted
    expect(embedderWouldTouch(hadVector)).toBe(false);
    expect(embedderWouldTouch(afterInvalidation)).toBe(true);
  });
});


/**
 * WHY THIS FILE WAS NOT ENOUGH (2026-08-23).
 *
 * Every test above passes against a MIRROR of the decision, restated in
 * TypeScript. That pins the rule, and it is worth pinning — but it cannot
 * execute the SQL the rule actually lives in.
 *
 * So when the upsert shipped with
 *
 *   RETURNING id, (xmax = 0) AS inserted,
 *             (xmax <> 0 AND jobs.description IS DISTINCT FROM EXCLUDED.description)
 *
 * all 576 tests stayed green while EVERY company sync threw 42P01: the
 * ON CONFLICT alias is only in scope inside DO UPDATE SET and its WHERE, never
 * in RETURNING. Crawls ran, found jobs, and lost them for three hours.
 *
 * A mirror test must never be mistaken for coverage of the statement it
 * mirrors. These read the real source and fail on the shape that broke.
 */
describe('the upsert SQL itself', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source: string = fs.readFileSync(path.join(__dirname, 'ingest.service.ts'), 'utf8');

  // Prose mentions RETURNING too. Only executable SQL is of interest here.
  const sql = source
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]*--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it('never references EXCLUDED from a RETURNING clause', () => {
    const blocks = [...sql.matchAll(/\n[ \t]*RETURNING[\s\S]*?`/g)].map((m) => m[0]);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(/EXCLUDED/i);
    }
  });

  it('still detects a changed body — the invariant was not dropped to fix the crash', () => {
    // Guards the other direction: deleting the feature would also make the
    // test above pass.
    expect(source).toMatch(/previousBody/);
    expect(source).toMatch(/restaleIds\.push/);
  });
});
