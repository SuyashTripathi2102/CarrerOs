import { normalizeCountry } from './country';

/**
 * Regression suite for the country-normalization incident (2026-08-15).
 *
 * Every surface filters on `country = 'IN' OR workMode = 'REMOTE'`. Workable
 * and Recruitee passed their source's locale string through unchanged, so the
 * corpus held 567 active India jobs stored as `'India'` — invisible to Browse,
 * Today, matching and notifications. One was an evaluated APPLY at 77.3 the
 * user could never see. Singapore (246), Malaysia (212), United States (203)
 * and 43 other names were affected, including German locale ("Deutschland").
 */
describe('normalizeCountry', () => {
  describe('the forms that caused the incident', () => {
    const cases: [string, string][] = [
      ['India', 'IN'],
      ['IN', 'IN'],
      ['India, IN', 'IN'],
      ['Bengaluru, India', 'IN'],
      ['Remote - India', 'IN'],
      ['India / Remote', 'IN'],
      ['United States', 'US'],
      ['Singapore', 'SG'],
    ];

    it.each(cases)('%p -> %p', (input, expected) => {
      expect(normalizeCountry(input)).toBe(expected);
    });
  });

  describe('every non-ISO value observed in the corpus resolves', () => {
    // Taken verbatim from `SELECT DISTINCT country ... WHERE country !~ '^[A-Z]{2}$'`.
    const observed: [string, string][] = [
      ['Albania', 'AL'],
      ['Algeria', 'DZ'],
      ['Argentina', 'AR'],
      ['Armenia', 'AM'],
      ['Australia', 'AU'],
      ['Belgium', 'BE'],
      ['Brazil', 'BR'],
      ['Bulgaria', 'BG'],
      ['Canada', 'CA'],
      ['Colombia', 'CO'],
      ['Czechia', 'CZ'],
      ['Deutschland', 'DE'],
      ['Egypt', 'EG'],
      ['France', 'FR'],
      ['Germany', 'DE'],
      ['Honduras', 'HN'],
      ['Hong Kong', 'HK'],
      ['Hungary', 'HU'],
      ['Indonesia', 'ID'],
      ['Ireland', 'IE'],
      ['Israel', 'IL'],
      ['Japan', 'JP'],
      ['Luxembourg', 'LU'],
      ['Malaysia', 'MY'],
      ['Mexico', 'MX'],
      ['Nepal', 'NP'],
      ['Netherlands', 'NL'],
      ['New Zealand', 'NZ'],
      ['Philippines', 'PH'],
      ['Poland', 'PL'],
      ['Portugal', 'PT'],
      ['Romania', 'RO'],
      ['Saudi Arabia', 'SA'],
      ['Slovakia', 'SK'],
      ['South Africa', 'ZA'],
      ['South Korea', 'KR'],
      ['Spain', 'ES'],
      ['Taiwan', 'TW'],
      ['Thailand', 'TH'],
      ['Turkey', 'TR'],
      ['United Arab Emirates', 'AE'],
      ['United Kingdom', 'GB'],
      ['Vietnam', 'VN'],
    ];

    it.each(observed)('%p -> %p', (input, expected) => {
      expect(normalizeCountry(input)).toBe(expected);
    });
  });

  describe('does NOT invent a country', () => {
    it('rejects "worldwide" — a remote scope, not a market', () => {
      // Present in the corpus as a country value. Mapping it anywhere would
      // silently place jobs in a market they are not in.
      expect(normalizeCountry('worldwide')).toBeNull();
    });

    it.each(['Remote', 'Anywhere', 'Global', 'EMEA', 'APAC', 'Europe', 'N/A', '-'])(
      'rejects %p',
      (input) => {
        expect(normalizeCountry(input)).toBeNull();
      },
    );

    it('rejects a two-letter string that is not an ISO code', () => {
      expect(normalizeCountry('XX')).toBeNull();
      expect(normalizeCountry('ZZ')).toBeNull();
    });

    it('returns null for empty and missing input', () => {
      expect(normalizeCountry(null)).toBeNull();
      expect(normalizeCountry(undefined)).toBeNull();
      expect(normalizeCountry('')).toBeNull();
      expect(normalizeCountry('   ')).toBeNull();
    });
  });

  describe('substring traps — the false positives this must never create', () => {
    it('does not map Indianapolis to India', () => {
      // A naive /india/ match makes every Indianapolis job an Indian job.
      expect(normalizeCountry('Indianapolis')).toBeNull();
    });

    it('does not treat a US state code in a composite as a country', () => {
      // "Indianapolis, IN" is Indiana, USA. A bare two-letter code is only
      // honoured as ISO when it is the entire input, precisely for this case.
      expect(normalizeCountry('Indianapolis, IN')).not.toBe('IN');
    });

    it('does not map "Indiana" to India', () => {
      expect(normalizeCountry('Indiana')).toBeNull();
    });

    it('does not map Turkmenistan to Turkey', () => {
      expect(normalizeCountry('Turkmenistan')).toBeNull();
    });
  });

  describe('normalization details', () => {
    it('is case-insensitive', () => {
      expect(normalizeCountry('india')).toBe('IN');
      expect(normalizeCountry('INDIA')).toBe('IN');
      expect(normalizeCountry('in')).toBe('IN');
    });

    it('trims surrounding whitespace and punctuation', () => {
      expect(normalizeCountry('  India  ')).toBe('IN');
      expect(normalizeCountry('(India)')).toBe('IN');
    });

    it('handles common aliases', () => {
      expect(normalizeCountry('USA')).toBe('US');
      expect(normalizeCountry('UK')).toBe('GB');
      expect(normalizeCountry('UAE')).toBe('AE');
    });

    it('finds a multi-word country at the tail of a location string', () => {
      expect(normalizeCountry('Greater London Area United Kingdom')).toBe('GB');
    });

    it('is idempotent — normalizing an already-normalized value is a no-op', () => {
      const once = normalizeCountry('Bengaluru, India');
      expect(normalizeCountry(once)).toBe(once);
    });
  });
});
