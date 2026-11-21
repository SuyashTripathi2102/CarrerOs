import { kekaPostedAt } from './keka';

/** Gap N-01 (2026-11-21): Keka's "no date" placeholder failed FloBiz's whole crawl. */
describe('kekaPostedAt', () => {
  it("treats .NET's DateTime.MinValue placeholder as no date", () => {
    expect(kekaPostedAt('0001-01-01T00:00:00')).toBeNull();
    expect(kekaPostedAt('0001-01-01T00:00:00Z')).toBeNull();
  });

  it('treats a missing or unparseable value as no date instead of throwing', () => {
    expect(kekaPostedAt(undefined)).toBeNull();
    expect(kekaPostedAt('')).toBeNull();
    expect(() => kekaPostedAt('not a date')).not.toThrow();
    expect(kekaPostedAt('not a date')).toBeNull();
  });

  it('keeps a real publish date', () => {
    expect(kekaPostedAt('2026-11-20T09:30:00Z')).toBe(
      '2026-11-20T09:30:00.000Z',
    );
  });
});
