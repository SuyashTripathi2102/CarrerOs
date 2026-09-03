/**
 * SELECTION IS BY DECISION, NOT BY SIMILARITY (2026-08-28).
 *
 * `browseByFit` builds the pool that feeds /today and /browse. It ordered
 * evaluated jobs first — correct — and then by COSINE, which quietly meant
 * similarity decided which decisions were eligible to be seen. With ~8,700
 * evaluated jobs the pool filled entirely from them, sorted by a signal that is
 * not the decision.
 *
 * Measured against the live corpus, same LIMIT, same candidate universe:
 *
 *   cosine, LIMIT 72             APPLY  3   CONSIDER 20
 *   opportunityScore, LIMIT 72   APPLY 47   CONSIDER 25
 *   cosine, LIMIT 200            APPLY  9   CONSIDER 40   <- size does not fix it
 *   total available              APPLY 59   CONSIDER 286
 *
 * These tests exist because the failure is INVISIBLE in production: nothing
 * errors, no verdict changes, no score changes. /today simply renders fewer,
 * worse cards, and looks entirely healthy doing it. A reviewer optimising the
 * query later would have no way to know cosine-second was load-bearing.
 */
describe('the surface pool is ordered by the decision', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source: string = fs.readFileSync(
    path.join(__dirname, 'matching.service.ts'),
    'utf8',
  );

  /** The prose above the query discusses cosine at length; only SQL counts. */
  const sql = source
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]*--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  /** The pool's ORDER BY — the one immediately followed by `LIMIT ${pool}`. */
  const poolOrderBy = (() => {
    // Must not span an earlier query: a plain non-greedy match starts at the
    // FIRST ORDER BY in the file and swallows every statement up to this
    // LIMIT, which made the key-order assertion below compare the wrong
    // clauses. Allow no intervening ORDER BY.
    const m = sql.match(/ORDER BY(?:(?!ORDER BY)[\s\S])*?LIMIT \$\{pool\}/);
    if (!m) throw new Error('pool ORDER BY not found — did the query move?');
    return m[0];
  })();

  it('ranks evaluated jobs ahead of unevaluated ones', () => {
    // An approved job must never sit below a merely-similar unjudged one.
    expect(poolOrderBy).toMatch(/decidedAt"?\s+IS NOT NULL\)?\s+DESC/);
  });

  it('orders evaluated jobs by opportunityScore, NOT by cosine', () => {
    // The regression this file exists to prevent.
    expect(poolOrderBy).toMatch(/opportunityScore"?\s+DESC/);
  });

  it('puts opportunityScore BEFORE the cosine term', () => {
    // Order of keys is the whole point: cosine first re-creates the bug while
    // leaving the opportunityScore term present and looking correct.
    const opp = poolOrderBy.search(/opportunityScore/);
    const cos = poolOrderBy.search(/vector <=> re\.vector/);
    expect(opp).toBeGreaterThan(-1);
    expect(cos).toBeGreaterThan(-1);
    expect(opp).toBeLessThan(cos);
  });

  it('keeps cosine as the LAST key, for the undecided tail', () => {
    // Unevaluated jobs have opportunityScore NULL by definition — a score they
    // have not earned. Similarity is the only honest signal for ordering them,
    // so it must remain, just no longer in charge.
    expect(poolOrderBy).toMatch(/vector <=> re\.vector/);
    expect(poolOrderBy).toMatch(/NULLS LAST/);
  });

  it('does not widen the pool to compensate', () => {
    // Measured: LIMIT 200 under cosine still reached only 9 of 59 APPLY. If a
    // future change "fixes" recall by enlarging the pool instead of fixing the
    // ordering, it is paying for the wrong thing.
    expect(source).toMatch(/const pool = Math\.min\(200, limit \* 3\)/);
  });
});

/**
 * THE COLLECTOR MUST NOT DRIFT FROM PRODUCTION (2026-09-03).
 *
 * `scripts/phase0-baseline.sql` records `surfaceable_apply` daily by
 * REPLICATING browseByFit's pool ordering in standalone SQL. When Q2 changed
 * production on 2026-08-28, that copy was not updated — so for five days the
 * daily metric reported 3 while production actually reached 50. A 16x
 * under-report, on a dashboard, that made a shipped fix look like it had done
 * nothing.
 *
 * Nothing errored. The number was simply measuring a version of CareerOS that
 * no longer existed, which is the hardest class of bug to notice.
 *
 * The principle: a metric must derive from the same ordering as the behaviour
 * it claims to measure. Where an exact shared function isn't possible across a
 * TS service and a standalone .sql file, this test is the seam that holds them
 * together.
 */
describe('phase0-baseline.sql mirrors browseByFit', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  /** Reduce an ORDER BY to its ordered list of ranking keys, ignoring layout. */
  const keys = (clause: string): string[] => {
    const out: string[] = [];
    for (const m of clause.matchAll(/decidedAt|opportunityScore|vector\s*<=>/g)) {
      const t = m[0].replace(/\s+/g, '');
      out.push(t === 'vector<=>' ? 'cosine' : t);
    }
    return out;
  };

  const strip = (s: string) =>
    s.replace(/^[ \t]*--.*$/gm, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const service = strip(
    fs.readFileSync(path.join(__dirname, 'matching.service.ts'), 'utf8'),
  );
  const collector = strip(
    fs.readFileSync(
      path.join(__dirname, '../../../../../scripts/phase0-baseline.sql'),
      'utf8',
    ),
  );

  const prodClause = service.match(/ORDER BY(?:(?!ORDER BY)[\s\S])*?LIMIT \$\{pool\}/)?.[0];
  const collectorClause = collector.match(/ORDER BY(?:(?!ORDER BY)[\s\S])*?\)\s*AS rn/)?.[0];

  it('finds both ordering clauses', () => {
    expect(prodClause).toBeDefined();
    expect(collectorClause).toBeDefined();
  });

  it('ranks by the SAME keys in the SAME order', () => {
    // If this fails, one of the two was changed alone. Change both, or the
    // daily metric silently starts describing a system that is not running.
    expect(keys(collectorClause!)).toEqual(keys(prodClause!));
  });

  it('and that order is decision-first, cosine last', () => {
    expect(keys(prodClause!)).toEqual(['decidedAt', 'opportunityScore', 'cosine']);
  });
});
