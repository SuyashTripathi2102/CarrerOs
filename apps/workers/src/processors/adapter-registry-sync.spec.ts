import { CRAWLABLE_PROVIDERS } from '@careeros/shared';
import { CRAWLABLE_ADAPTER_NAMES } from './crawl-company.processor';

/**
 * The two lists MUST agree, and drift between them has now cost twice:
 *
 *   2026-07-08  WORKABLE had a shipped adapter but was missing from
 *               CRAWLABLE_PROVIDERS, so 36 monitored india-seed companies were
 *               never handed out for crawling.
 *   2026-08-22  WORKDAY had a shipped adapter that passed a nine-check canary
 *               but appeared in NEITHER list, so 8 boards found by the full
 *               Bengaluru sweep sat uncrawlable behind a working component.
 *
 * Both failures are silent in opposite directions:
 *
 *   in CRAWLABLE, no adapter  -> companies handed out, crawl-company throws
 *                                "No adapter for ATS provider X" every tick
 *   adapter, not in CRAWLABLE -> companies never handed out at all, and
 *                                nothing errors. Invisible.
 *
 * The second is worse precisely because it looks like healthy silence, so this
 * asserts equality rather than one-way containment. A comment saying "keep in
 * sync" is what both incidents already had.
 */
describe('adapter registry and CRAWLABLE_PROVIDERS agree', () => {
  // Compared as plain strings: the point is that the two SETS match, and
  // narrowing to the enum would let a name that is not a valid provider slip
  // through as a type error rather than a test failure.
  const adapters: string[] = [...CRAWLABLE_ADAPTER_NAMES].sort();
  const crawlable: string[] = [...CRAWLABLE_PROVIDERS].sort();

  it('every CRAWLABLE provider has an adapter (else crawl-company throws)', () => {
    expect(crawlable.filter((p) => !adapters.includes(p))).toEqual([]);
  });

  it('every adapter is CRAWLABLE (else its companies are never handed out)', () => {
    expect(adapters.filter((p) => !crawlable.includes(p))).toEqual([]);
  });

  it('the two lists are identical', () => {
    expect(adapters).toEqual(crawlable);
  });

  it('includes WORKDAY — the 2026-08-22 gap', () => {
    expect(adapters).toContain('WORKDAY');
    expect(crawlable).toContain('WORKDAY');
  });

  it('does NOT include DARWINBOX until an adapter exists', () => {
    // 20 boards in the Bengaluru universe and the largest remaining gap, but
    // listing it before the adapter ships turns a missing capability into a
    // crawl that throws on every tick.
    expect(adapters).not.toContain('DARWINBOX');
    expect(crawlable).not.toContain('DARWINBOX');
  });
});
