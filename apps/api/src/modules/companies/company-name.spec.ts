import { normalizeCompanyName, sameCompanyName } from './company-name';

/**
 * Regression suite for the company-alias dedup gap (2026-08-13).
 *
 * `findOrCreateFromBoard` matched company names exactly, so a feed naming an
 * employer "Zensar" and another naming it "Zensar Technologies" created two
 * company rows. `jobFingerprint` is keyed on companyId, so one real opening
 * produced two fingerprints, survived cross-source dedup, and was counted
 * twice in the APPLY list — a 20% overstatement of the only KPI that matters.
 *
 * The observed pairs are pinned below. The rest guard the opposite failure:
 * merging two employers that merely share a prefix is far worse than showing
 * one job twice, so those cases must stay distinct.
 */
describe('normalizeCompanyName', () => {
  describe('collapses the observed duplicate pairs', () => {
    const pairs: [string, string][] = [
      ['Zensar', 'Zensar Technologies'],
      ['HEXAWARE', 'Hexaware Technologies'],
      ['Danaher', 'Danaher Corporation'],
      ['Nordson', 'Nordson Corporation'],
    ];

    it.each(pairs)('%s === %s', (a, b) => {
      expect(sameCompanyName(a, b)).toBe(true);
    });
  });

  describe('handles the suffix forms Indian job boards actually emit', () => {
    it('strips stacked suffixes', () => {
      expect(normalizeCompanyName('Acme Technologies Pvt Ltd')).toBe('acme');
    });

    it('strips punctuated suffixes', () => {
      expect(normalizeCompanyName('Acme Inc.')).toBe('acme');
      expect(normalizeCompanyName('Acme, LLC')).toBe('acme');
    });

    it('is case and whitespace insensitive', () => {
      expect(sameCompanyName('  ACME   TECHNOLOGIES ', 'Acme')).toBe(true);
    });

    it('ignores punctuation differences', () => {
      expect(sameCompanyName('Tech-Dome', 'Tech Dome')).toBe(true);
    });
  });

  describe('never merges genuinely different employers', () => {
    // A descriptive word is not a legal suffix — these are different companies.
    const distinct: [string, string][] = [
      ['Apple', 'Apple Bank'],
      ['Acme', 'Acme Capital'],
      ['Sun', 'Sun Pharma'],
      ['Zensar', 'Zenith'],
      ['Infosys', 'Infosys BPM'],
      ['Tata', 'Tata Steel'],
    ];

    it.each(distinct)('%s !== %s', (a, b) => {
      expect(sameCompanyName(a, b)).toBe(false);
    });
  });

  describe('degenerate input', () => {
    it('keeps a name that is nothing but suffixes', () => {
      // Stripping everything would make every such row collide.
      expect(normalizeCompanyName('Ltd')).toBe('ltd');
    });

    it('does not collapse below the identity threshold', () => {
      // "The Co" -> "the" is too generic to key on, so the full form is kept.
      expect(normalizeCompanyName('The Co')).toBe('the co');
    });

    it('survives an empty-ish name without throwing', () => {
      expect(() => normalizeCompanyName('   ')).not.toThrow();
    });

    it('is idempotent — normalizing twice changes nothing', () => {
      const once = normalizeCompanyName('Zensar Technologies Pvt Ltd');
      expect(normalizeCompanyName(once)).toBe(once);
    });
  });
});
