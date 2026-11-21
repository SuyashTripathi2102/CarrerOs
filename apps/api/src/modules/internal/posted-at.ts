/**
 * Posting-date sanity check — every job's `postedAt` is either a plausible
 * instant or null.
 *
 * Why this exists (2026-11-21, gap N-01): Keka sends .NET's "no date"
 * placeholder `0001-01-01T00:00:00` for some jobs. Read as local time in
 * Asia/Kolkata (whose historical offset for year 1 is +05:53:28) it becomes
 * `0000-12-31T18:06:32.000Z` — a year Postgres cannot store. The
 * `posted_at::timestamptz` cast in the batch INSERT then failed the WHOLE
 * company crawl: FloBiz failed 81 crawls in 7 days and none of its jobs were
 * refreshed.
 *
 * Like country normalization, this runs at the single ingest choke point, so a
 * new source cannot reintroduce the failure. An implausible date is UNKNOWN,
 * not wrong: the job is kept and `postedAt` stays null (`firstSeenAt` still
 * dates it). A plausible value is returned unchanged, so valid dates are
 * stored exactly as before.
 */

/** No job in the corpus can have been posted before this. */
const EARLIEST_MS = Date.UTC(2000, 0, 1);
/** Source clocks and time zones may run a little ahead; a posting date cannot be days in the future. */
const FUTURE_SKEW_MS = 2 * 24 * 60 * 60 * 1000;

export function plausiblePostedAt(
  value: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  if (t < EARLIEST_MS || t > now.getTime() + FUTURE_SKEW_MS) return null;
  return value;
}
