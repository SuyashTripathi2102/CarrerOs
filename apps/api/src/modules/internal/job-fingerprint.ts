import { createHash } from 'crypto';

/**
 * Cross-source job fingerprint. The same opening reaches us from several sources
 * with different external IDs — Adzuna's numeric id, Jooble's uid, our
 * `careerpage-<hash>` — so `(companyId, externalId)` alone lets three rows exist
 * for one real job. The fingerprint is a stable, source-independent identity so
 * we can collapse those before they pollute Browse/Today.
 *
 * Design goals:
 *  - Order-invariant: "Senior Backend Engineer" ≡ "Backend Engineer (Senior)".
 *  - Meaning-preserving: "Senior …" ≠ "Junior …" (seniority is a real signal).
 *  - Company-scoped: the same title at two employers is two different jobs.
 *  - Conservative on location: only an exact normalised match merges, so we
 *    under-merge rather than fuse genuinely distinct city postings.
 */

// Structural filler that carries no identity — dropping it makes ordering and
// punctuation differences collapse without merging distinct roles.
const NOISE = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'and',
  'to',
  'in',
  'at',
  'with',
  'on',
  'our',
  'we',
  'are',
  'is',
  'hiring',
  'job',
  'role',
  'position',
  'opening',
  'vacancy',
]);

/**
 * Title → canonical token bag: lowercase, strip everything but letters/digits,
 * drop noise words, de-duplicate, sort. Sorting is what makes word order and
 * parenthetical placement irrelevant while keeping every meaningful token
 * (including seniority) as part of the identity.
 */
export function normalizeTitle(title: string): string {
  const tokens = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NOISE.has(t));
  return Array.from(new Set(tokens)).sort().join(' ');
}

/** Location → coarse key: lowercase, alnum-only, collapsed. Empty when absent. */
export function normalizeLocation(location?: string | null): string {
  if (!location) return '';
  return location
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export interface FingerprintInput {
  companyId: string;
  title: string;
  location?: string | null;
  workMode?: string | null; // REMOTE | HYBRID | ONSITE | null
}

/**
 * Stable 128-bit (32 hex char) fingerprint. SHA-256 truncated — collisions are
 * astronomically unlikely at our corpus size and half the storage of full hex.
 */
export function jobFingerprint(input: FingerprintInput): string {
  const basis = [
    input.companyId,
    normalizeTitle(input.title),
    normalizeLocation(input.location),
    (input.workMode ?? '').toUpperCase(),
  ].join('::');
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}
