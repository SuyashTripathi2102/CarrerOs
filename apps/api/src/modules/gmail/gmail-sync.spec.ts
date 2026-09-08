import {
  planSync,
  seedQuery,
  isHistoryExpired,
  reseedPlan,
  mayAdvanceCursor,
  isSuspiciousOutcome,
  describeOutcome,
  SEED_WINDOW_DAYS,
} from './gmail-sync';

const SENDERS = ['jobalerts-noreply@linkedin.com'];

describe('planSync', () => {
  it('seeds a connection that has never synced', () => {
    expect(planSync({ historyId: null }, SENDERS)).toEqual({
      mode: 'SEED',
      query: expect.stringContaining('newer_than:30d'),
      reason: 'first-connect',
    });
  });

  it('goes incremental once a cursor exists', () => {
    expect(planSync({ historyId: '987654' }, SENDERS)).toEqual({
      mode: 'INCREMENTAL',
      startHistoryId: '987654',
    });
  });

  it('never scans the whole mailbox — the seed is bounded', () => {
    // An unbounded sweep would pull years of digests for jobs long filled, and
    // every one would cost classification downstream.
    expect(seedQuery(SENDERS)).toContain(`newer_than:${SEED_WINDOW_DAYS}d`);
  });

  it('scopes the seed to the alert senders, not the inbox', () => {
    const q = seedQuery(['a@x.com', 'b@y.com']);
    expect(q).toContain('from:a@x.com');
    expect(q).toContain('from:b@y.com');
    expect(q).toMatch(/^\(.*\) newer_than/);
  });

  it('refuses to build a query with no senders', () => {
    // Without a sender filter this would match the entire mailbox.
    expect(() => seedQuery([])).toThrow(/at least one sender/);
  });
});

describe('isHistoryExpired', () => {
  it('recognises Gmail 404 for a dropped historyId', () => {
    expect(isHistoryExpired({ code: 404 })).toBe(true);
    expect(isHistoryExpired({ response: { status: 404 } })).toBe(true);
  });

  it('does not treat other failures as expiry', () => {
    // Re-seeding on a 500 or a 429 would turn a transient outage into a full
    // 30-day re-read every run.
    expect(isHistoryExpired({ code: 500 })).toBe(false);
    expect(isHistoryExpired({ code: 429 })).toBe(false);
    expect(isHistoryExpired(new Error('fetch failed'))).toBe(false);
    expect(isHistoryExpired(null)).toBe(false);
  });

  it('re-seed is bounded and labelled, so a permanent fallback is visible', () => {
    const plan = reseedPlan(SENDERS);
    expect(plan).toEqual({
      mode: 'SEED',
      query: expect.stringContaining('newer_than:30d'),
      reason: 'history-expired',
    });
  });
});

describe('mayAdvanceCursor — the correctness rule', () => {
  /**
   * Advance-then-ingest turns any crash into permanently lost alerts with no
   * error anywhere. Ingest-then-advance turns the same crash into a duplicate
   * read, which the three dedup layers absorb. These tests pin that asymmetry.
   */

  it('advances only when every attempted ingest succeeded', () => {
    expect(mayAdvanceCursor({ ingestAttempted: 12, ingestSucceeded: 12, errors: 0 })).toBe(true);
  });

  it('does NOT advance on a partial batch', () => {
    expect(mayAdvanceCursor({ ingestAttempted: 12, ingestSucceeded: 11, errors: 0 })).toBe(false);
  });

  it('does NOT advance when anything errored', () => {
    expect(mayAdvanceCursor({ ingestAttempted: 12, ingestSucceeded: 12, errors: 1 })).toBe(false);
  });

  it('advances on a genuinely empty run', () => {
    // Nothing arrived; the cursor must still move or an idle connection would
    // re-query the same empty window forever.
    expect(mayAdvanceCursor({ ingestAttempted: 0, ingestSucceeded: 0, errors: 0 })).toBe(true);
  });
});

describe('isSuspiciousOutcome — zero is a reading, not a success', () => {
  it('flags matched-alerts-but-parsed-nothing', () => {
    // The template-changed failure. It produces the same "0 new jobs" as a
    // quiet week, and the two are indistinguishable after the fact.
    expect(isSuspiciousOutcome({ messagesScanned: 40, alertsMatched: 6, jobsParsed: 0, parseFailures: 6 })).toBe(true);
  });

  it('does not flag a genuinely quiet run', () => {
    expect(isSuspiciousOutcome({ messagesScanned: 40, alertsMatched: 0, jobsParsed: 0, parseFailures: 0 })).toBe(false);
  });

  it('does not flag a normal run', () => {
    expect(isSuspiciousOutcome({ messagesScanned: 40, alertsMatched: 6, jobsParsed: 51, parseFailures: 0 })).toBe(false);
  });

  it('says so in the log line', () => {
    const msg = describeOutcome('linkedin-alerts', {
      messagesScanned: 40, alertsMatched: 6, jobsParsed: 0, parseFailures: 6,
    });
    expect(msg).toMatch(/template has probably changed/);
    expect(describeOutcome('linkedin-alerts', {
      messagesScanned: 40, alertsMatched: 6, jobsParsed: 51, parseFailures: 0,
    })).not.toMatch(/template/);
  });
});
