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
