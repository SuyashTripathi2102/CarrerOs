/**
 * Company-name identity for dedup.
 *
 * Board sources name the same employer differently — "Zensar" from one feed,
 * "Zensar Technologies" from another. `findByName` matches exactly, so each
 * variant became its own company row, and because `jobFingerprint` is keyed on
 * `companyId`, the SAME opening produced two different fingerprints and
 * survived cross-source dedup. Measured 2026-08-13: 4 duplicate company pairs
 * (Danaher, HEXAWARE, Nordson, Zensar) inflating the APPLY count by 20%.
 *
 * The fix is deliberately narrow. Only trailing *legal-entity* suffixes are
 * stripped, and only from the end. Words that can genuinely distinguish two
 * employers — "Bank", "Capital", "Health", "Labs" — are never touched, so
 * "Apple" and "Apple Bank" stay separate. Under-merging is the safe failure:
 * a missed merge shows one job twice, a wrong merge attributes a job to the
 * wrong employer.
 */

/** Trailing legal/incorporation markers. Not descriptive words. */
const LEGAL_SUFFIXES = new Set([
  'inc',
  'llc',
  'llp',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'gmbh',
  'ag',
  'bv',
  'nv',
  'sa',
  'srl',
  'spa',
  'oy',
  'ab',
  'as',
  'pte',
  'pty',
  'pvt',
  'private',
  'technologies',
  'technology',
]);

/** Below this, stripping has eaten the identity — keep the original instead. */
const MIN_BASE_LENGTH = 3;

/**
 * Words that identify nobody. If stripping suffixes leaves only these, the
 * key would collide across unrelated employers ("The Co" and "The Ltd" both
 * reducing to "the"), so the unstripped form is kept instead.
 */
const NON_IDENTIFYING = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'my', 'our', 'we']);

/**
 * Canonical identity key for a company name: lowercase, punctuation removed,
 * trailing legal suffixes stripped repeatedly ("Acme Technologies Pvt Ltd" →
 * "acme"). Returns the collapsed form; never returns empty.
 */
export function normalizeCompanyName(name: string): string {
  const tokens = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return name.trim().toLowerCase();

  // Strip from the end while suffixes remain AND something identifying is left.
  const base = [...tokens];
  while (base.length > 1 && LEGAL_SUFFIXES.has(base[base.length - 1])) {
    base.pop();
  }

  const collapsed = base.join(' ');
  // Reject a base that is too short, or that carries no identifying word —
  // "The Co" reducing to "the" would collide with every other "The <suffix>".
  const identifying =
    collapsed.length >= MIN_BASE_LENGTH && base.some((t) => !NON_IDENTIFYING.has(t));
  return identifying ? collapsed : tokens.join(' ');
}

/** Do two company names refer to the same employer? */
export function sameCompanyName(a: string, b: string): boolean {
  return normalizeCompanyName(a) === normalizeCompanyName(b);
}
