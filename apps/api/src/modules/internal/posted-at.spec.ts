import { plausiblePostedAt } from './posted-at';

/**
 * Regression suite for gap N-01 (2026-11-21): one Keka job's "no date"
 * placeholder reached the batch INSERT as `0000-12-31T18:06:32.000Z`, the
 * `timestamptz` cast failed with Postgres 22008, and FloBiz's whole crawl
 * failed 81 times in 7 days.
 */
describe('plausiblePostedAt', () => {
  const now = new Date('2026-11-21T12:00:00Z');

  it('turns the exact value that failed FloBiz into unknown', () => {
    expect(plausiblePostedAt('0000-12-31T18:06:32.000Z', now)).toBeNull();
  });

  it("turns .NET's DateTime.MinValue placeholder into unknown", () => {
    expect(plausiblePostedAt('0001-01-01T00:00:00', now)).toBeNull();
    expect(plausiblePostedAt('0001-01-01T00:00:00Z', now)).toBeNull();
  });

  it('keeps a plausible date exactly as the source sent it', () => {
    expect(plausiblePostedAt('2026-11-20T09:30:00Z', now)).toBe(
      '2026-11-20T09:30:00Z',
    );
    expect(plausiblePostedAt('2026-11-20T09:30:00+05:30', now)).toBe(
      '2026-11-20T09:30:00+05:30',
    );
    expect(plausiblePostedAt('2026-11-20T09:30:00', now)).toBe(
      '2026-11-20T09:30:00',
    );
  });

  it('treats absent and unparseable values as unknown, never throwing', () => {
    expect(plausiblePostedAt(null, now)).toBeNull();
    expect(plausiblePostedAt(undefined, now)).toBeNull();
    expect(plausiblePostedAt('', now)).toBeNull();
    expect(plausiblePostedAt('not a date', now)).toBeNull();
  });

  it('rejects dates before 2000', () => {
    expect(plausiblePostedAt('1999-12-31T23:59:59Z', now)).toBeNull();
    expect(plausiblePostedAt('2000-01-01T00:00:00Z', now)).toBe(
      '2000-01-01T00:00:00Z',
    );
  });

  it('allows small clock skew into the future but not days ahead', () => {
    expect(plausiblePostedAt('2026-11-22T12:00:00Z', now)).toBe(
      '2026-11-22T12:00:00Z',
    );
    expect(plausiblePostedAt('2026-11-24T12:00:00Z', now)).toBeNull();
  });
});
