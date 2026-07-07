import { Prisma } from '@prisma/client';

/**
 * Country → location-string patterns. `jobs.country` is null on ~90% of rows
 * (ATS payloads rarely carry it), so preference filtering must fall back to
 * matching the free-form location string. Strict by design: a job that names
 * neither the country nor one of its cities does NOT pass — "Remote (global)"
 * is excluded when a countries preference is set (2026-07-08, Suyash: India
 * only for now; US-remote notifications were noise).
 */
const COUNTRY_LOCATION_PATTERNS: Record<string, string> = {
  IN: 'india|bengaluru|bangalore|mumbai|pune|new delhi|delhi ncr|delhi|hyderabad|chennai|noida|gurgaon|gurugram|indore|kolkata|ahmedabad|jaipur|kochi|trivandrum|chandigarh',
};

function locationPatternFor(countries: string[]): string | null {
  const parts = countries
    .map((c) => COUNTRY_LOCATION_PATTERNS[c.toUpperCase()])
    .filter((p): p is string => !!p);
  return parts.length ? parts.join('|') : null;
}

/** SQL predicate for the preferred-countries gate (TRUE when no preference). */
export function countrySql(countries: string[]): Prisma.Sql {
  if (countries.length === 0) return Prisma.sql`TRUE`;
  const pattern = locationPatternFor(countries);
  return pattern
    ? Prisma.sql`(j.country = ANY(${countries}) OR j.location ~* ${pattern})`
    : Prisma.sql`j.country = ANY(${countries})`;
}

/** JS-side twin of countrySql for the notification gate. */
export function jobMatchesCountries(
  countries: string[],
  job: { country: string | null; location: string | null },
): boolean {
  if (countries.length === 0) return true;
  if (job.country && countries.some((c) => c.toUpperCase() === job.country?.toUpperCase())) {
    return true;
  }
  const pattern = locationPatternFor(countries);
  return !!(pattern && job.location && new RegExp(pattern, 'i').test(job.location));
}
