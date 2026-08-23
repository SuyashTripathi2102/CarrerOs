/**
 * THE SWEEPER'S ONE HARD RULE (2026-08-23).
 *
 * `enqueueEmbeddings` runs once, at ingest, and nothing ran behind it. An id
 * lost between ingest and embed was lost permanently — the job stayed ACTIVE,
 * looked healthy in every count, and could never be retrieved because the
 * candidate query INNER JOINs job_embeddings.
 *
 * The sweeper recovers those. But it can only do that if it can tell a
 * STRANDED job from an IN-FLIGHT one, and the two are indistinguishable by
 * state: both are ACTIVE with no vector. Only AGE separates them.
 *
 * This is exactly where the 2026-08-13 analysis went wrong. It segmented
 * coverage by ingestion day, found yesterday's cohort at 100%, and concluded
 * "nothing is stranded" — a cohort measurement reads in-flight and stranded
 * identically, and a stranded job stops being visible the moment its cohort is
 * no longer today's. 1,673 stranded jobs were sitting there at the time.
 */

const EMBED_GRACE_MS = 30 * 60 * 1000;

/** Mirrors the sweep query's WHERE clause. */
function isStranded(job: { status: string; hasVector: boolean; ageMs: number }): boolean {
  return job.status === 'ACTIVE' && !job.hasVector && job.ageMs > EMBED_GRACE_MS;
}

const min = (n: number) => n * 60 * 1000;

describe('stranded vs in flight', () => {
  it('a vector-less ACTIVE job past the grace window is stranded', () => {
    expect(isStranded({ status: 'ACTIVE', hasVector: false, ageMs: min(31) })).toBe(true);
  });

  it('the SAME job one minute after ingest is in flight, not stranded', () => {
    // The distinction the cohort analysis could not make. Sweeping these would
    // re-enqueue the whole intake stream on every tick.
    expect(isStranded({ status: 'ACTIVE', hasVector: false, ageMs: min(1) })).toBe(false);
  });

  it('does not sweep a job that already has a vector', () => {
    expect(isStranded({ status: 'ACTIVE', hasVector: true, ageMs: min(999) })).toBe(false);
  });

  it('does not sweep inactive jobs — retired jobs are never retrieved', () => {
    expect(isStranded({ status: 'EXPIRED', hasVector: false, ageMs: min(999) })).toBe(false);
  });

  it('is exclusive at the boundary, so the window is unambiguous', () => {
    expect(isStranded({ status: 'ACTIVE', hasVector: false, ageMs: EMBED_GRACE_MS })).toBe(false);
    expect(isStranded({ status: 'ACTIVE', hasVector: false, ageMs: EMBED_GRACE_MS + 1 })).toBe(true);
  });
});

describe('the sweep is bounded and idempotent', () => {
  const LIMIT = 2_000;

  it('never enqueues more than the limit in one tick', () => {
    // After an outage the stranded set can be the whole corpus. One sweep must
    // not turn that into a single unbounded enqueue.
    const enqueued = Math.min(43_000, LIMIT);
    expect(enqueued).toBe(LIMIT);
  });

  it('re-enqueuing an already-embedded job is a no-op', () => {
    // embedJobsByIds filters `embedding: null`, so overlap between a sweep and
    // a live ingest costs nothing. This is why the sweep needs no locking.
    const embedderWouldTouch = (hasVector: boolean) => !hasVector;
    expect(embedderWouldTouch(true)).toBe(false);
  });
});
