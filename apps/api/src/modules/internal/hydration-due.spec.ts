import { readFileSync } from 'fs';
import { join } from 'path';
import { MIN_DESCRIPTION_CHARS } from '@careeros/shared';

/**
 * `hydrationDue` is one raw statement, so these pin its shape rather than mock
 * a database into agreeing with itself.
 *
 * The property that matters is not which jobs come back — it is that a job
 * which comes back is RECORDED as attempted in the same statement. Without
 * that, a detail page that never yields a body is re-fetched on every tick
 * forever: the 2026-08-12 candidate-queue starvation, pointed at somebody
 * else's web server.
 */

const src = readFileSync(join(__dirname, 'ingest.service.ts'), 'utf8');
const fn = (() => {
  const start = src.indexOf('async hydrationDue(');
  const end = src.indexOf('async repairDescriptions(', start);
  if (start < 0 || end < 0) throw new Error('hydrationDue not found in ingest.service.ts');
  return src.slice(start, end);
})();

describe('hydrationDue claims what it hands out', () => {
  it('records the attempt in the SAME statement that selects the batch', () => {
    // Selecting without claiming is the whole bug. Two statements would also
    // leave a window where a crash re-issues the same rows.
    expect(fn).toMatch(/UPDATE jobs SET "lastHydrationAttemptAt" = now\(\)/);
    expect(fn).toMatch(/WITH due AS \(/);
    expect(fn).toMatch(/RETURNING/);
  });

  it('excludes jobs attempted inside the backoff window', () => {
    expect(fn).toMatch(/"lastHydrationAttemptAt" IS NULL OR j\."lastHydrationAttemptAt" < \$\{retryAfter\}/);
  });

  it('backs off for days, not hours', () => {
    // The pages that fail are JS shells and login walls; they do not change by
    // tomorrow, and retrying daily would hammer third parties for nothing.
    const constant = src.match(/const HYDRATION_RETRY_MS = ([^;]+);/);
    expect(constant).not.toBeNull();
    // eslint-disable-next-line no-eval
    const ms = eval(constant![1]) as number;
    expect(ms).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('never-attempted jobs are tried first', () => {
    expect(fn).toMatch(/"lastHydrationAttemptAt" ASC NULLS FIRST/);
  });
});

describe('hydrationDue selects only jobs that can be helped', () => {
  it('requires an absolute http(s) URL — there is nowhere else to fetch from', () => {
    expect(fn).toMatch(/j\.url ~ '\^https\?:\/\/'/);
  });

  it('requires a body below the shared threshold, not a hardcoded number', () => {
    expect(fn).toMatch(/length\(COALESCE\(j\.description, ''\)\) < \$\{MIN_DESCRIPTION_CHARS\}/);
    expect(fn).not.toMatch(/<\s*200\b/);
  });

  it('only considers ACTIVE jobs', () => {
    // A REMOVED posting cannot be applied to, so its description is not worth
    // a fetch — and 16 of the 27 known stale rows are exactly that.
    expect(fn).toMatch(/j\.status = 'ACTIVE'/);
  });

  it('prioritises jobs a body would actually unstick', () => {
    expect(fn).toMatch(/m\."verdictCode" = 'INSUFFICIENT_EVIDENCE'/);
  });

  it('is bounded — one call cannot claim the corpus', () => {
    expect(fn).toMatch(/Math\.min\(200, Math\.max\(1, limit\)\)/);
    expect(fn).toMatch(/LIMIT \$\{capped\}/);
  });

  it('the shared threshold is the one the gate refuses on', () => {
    expect(MIN_DESCRIPTION_CHARS).toBe(200);
  });
});
