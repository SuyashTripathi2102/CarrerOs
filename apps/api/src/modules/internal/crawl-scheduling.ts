/**
 * Adaptive crawl scheduling. Crawling every monitored company on the same clock
 * is waste: a company shipping roles weekly deserves frequent visits, one that
 * hasn't posted in months does not, and one dead for a year should barely be
 * touched. This derives a crawl tier from the company's own hiring history so
 * the scheduler spends its (single-box) budget where jobs actually appear.
 */

export type Tier = 'HOT' | 'WARM' | 'COLD' | 'DORMANT';

/** Next-crawl interval per tier. DORMANT is the dead-company floor. */
export const TIER_INTERVAL_MS: Record<Tier, number> = {
  HOT: 30 * 60 * 1000, // 30 min — actively shipping roles
  WARM: 4 * 60 * 60 * 1000, // 4 h — normal cadence
  COLD: 24 * 60 * 60 * 1000, // 24 h — quiet lately
  DORMANT: 30 * 24 * 60 * 60 * 1000, // 30 d — no signs of life
};

export interface CrawlActivity {
  newJobs14d: number; // jobs first seen in the last 14 days
  activeJobs: number; // currently ACTIVE
  daysSinceLastNewJob: number | null; // null = never yielded a job
  crawlAttempts: number; // how many times we've crawled it (confidence guard)
}

/**
 * Company hiring activity → crawl tier.
 *  - DORMANT: enough crawls to be sure, nothing live, nothing new in ~4 months
 *    (or never). The dead-company case — visit monthly, not every 4 hours.
 *  - HOT: 3+ new roles in two weeks — visit often, catch fresh postings warm.
 *  - WARM: some recent activity.
 *  - COLD: quiet, but not provably dead.
 * The crawlAttempts guard stops a just-discovered company from being written off
 * after a single empty crawl.
 */
export function adaptiveTier(a: CrawlActivity): Tier {
  if (
    a.crawlAttempts >= 5 &&
    a.activeJobs === 0 &&
    (a.daysSinceLastNewJob == null || a.daysSinceLastNewJob > 120)
  ) {
    return 'DORMANT';
  }
  if (a.newJobs14d >= 3) return 'HOT';
  if (a.newJobs14d >= 1 || (a.daysSinceLastNewJob != null && a.daysSinceLastNewJob <= 30)) {
    return 'WARM';
  }
  return 'COLD';
}
