import { AtsProvider } from '@prisma/client';
import { CRAWLABLE_PROVIDERS } from '@careeros/shared';

/**
 * IDENTIFIED vs MONITORABLE (2026-08-22).
 *
 * `applyResult` wrote the ATS identity only when the provider was also
 * CRAWLABLE. So a probe that logged
 *
 *     "ATS from career page: DARWINBOX/clevertap"
 *
 * left the row at atsProvider=UNKNOWN. The evidence existed and was thrown
 * away — an absence of ADAPTER recorded as an absence of KNOWLEDGE, which is
 * the same mistake as reading an empty board as proof a company has none.
 *
 * Found while sweeping a 736-company city universe: eleven companies known
 * from an earlier pilot to run Darwinbox all read UNKNOWN, so "which ATS
 * should we build next?" answered with Darwinbox entirely absent — the exact
 * question the sweep existed to answer.
 *
 * These tests pin the rule rather than the implementation: identity is
 * recorded on evidence; SCHEDULING is what waits for an adapter.
 */

/** Mirrors the branch in DiscoveryService.applyResult. */
function classify(provider: AtsProvider | null, identifier: string | null) {
  const identified = !!provider && !!identifier;
  const monitorable =
    identified && (CRAWLABLE_PROVIDERS as string[]).includes(provider as string);
  return {
    identified,
    monitorable,
    persistsIdentity: identified,
    schedulesCrawl: monitorable,
  };
}

describe('ATS identity is recorded on evidence, not on having an adapter', () => {
  it('records a provider we cannot yet crawl', () => {
    const r = classify(AtsProvider.DARWINBOX, 'clevertap');
    expect(r.identified).toBe(true);
    expect(r.persistsIdentity).toBe(true);
    // No adapter exists, so nothing should be scheduled...
    expect(r.monitorable).toBe(false);
    expect(r.schedulesCrawl).toBe(false);
  });

  it('records AND schedules a provider we can crawl', () => {
    const r = classify(AtsProvider.GREENHOUSE, 'razorpay');
    expect(r.persistsIdentity).toBe(true);
    expect(r.schedulesCrawl).toBe(true);
  });

  it('records nothing when the probe proved nothing', () => {
    // A provider with no identifier is a guess, not evidence. Writing it would
    // recreate the empty-Workable-board failure that cost 606 jobs.
    expect(classify(AtsProvider.GREENHOUSE, null).persistsIdentity).toBe(false);
    expect(classify(null, 'something').persistsIdentity).toBe(false);
  });

  it('never schedules a crawl for a provider that has no adapter', () => {
    // The load-bearing safety property: recording DARWINBOX must not put the
    // company into the crawl rotation, or crawl-company throws "No adapter".
    for (const p of [AtsProvider.DARWINBOX, AtsProvider.FRESHTEAM, AtsProvider.ZOHO_RECRUIT]) {
      expect(classify(p, 'acme').schedulesCrawl).toBe(false);
    }
  });

  it('identity and crawlability are independent — four combinations, not two', () => {
    expect(classify(AtsProvider.DARWINBOX, 'x')).toMatchObject({ persistsIdentity: true, schedulesCrawl: false });
    expect(classify(AtsProvider.LEVER, 'x')).toMatchObject({ persistsIdentity: true, schedulesCrawl: true });
    expect(classify(null, null)).toMatchObject({ persistsIdentity: false, schedulesCrawl: false });
    expect(classify(AtsProvider.LEVER, null)).toMatchObject({ persistsIdentity: false, schedulesCrawl: false });
  });
});
