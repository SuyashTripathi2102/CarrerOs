/**
 * Company growth signal — a deterministic 0–100 read on how much momentum an
 * employer's hiring has right now, from data we already store. It answers the
 * question that matters for interview probability: "is this company actively,
 * increasingly hiring, or coasting?" A growing team reads more applications and
 * moves faster. Feeds the Opportunity Score's hiring-velocity module.
 *
 * Pure and unit-tested — no Prisma, no LLM. The service maps our HiringTrend
 * enum onto the local Trend union.
 */

export type Trend = 'GROWING' | 'STABLE' | 'DECLINING' | 'INSUFFICIENT_DATA';

export interface GrowthSignals {
  activeJobs: number; // scale of current hiring
  newRoles30d: number; // frequency — roles opened in the last 30 days
  trend: Trend; // momentum vs the prior window
  daysSinceLastJob: number | null; // recency — how warm the pipeline is
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/**
 * Trend from two 30-day windows. Needs enough monitoring history to be real —
 * a company we met last week has no meaningful "prior month", so it reports
 * INSUFFICIENT_DATA rather than a fake spike (the same discipline the
 * LLM-assisted velocity path uses).
 */
export function trendFrom(new30: number, prev30: number, enoughHistory: boolean): Trend {
  if (!enoughHistory) return 'INSUFFICIENT_DATA';
  if (prev30 === 0 && new30 === 0) return 'INSUFFICIENT_DATA';
  if (prev30 === 0) return new30 >= 2 ? 'GROWING' : 'STABLE';
  if (new30 > prev30 * 1.25) return 'GROWING';
  if (new30 < prev30 * 0.75) return 'DECLINING';
  return 'STABLE';
}

/**
 * Blend scale + frequency + momentum + recency into one score:
 *  - active openings (up to 35): how much hiring is happening at all
 *  - new roles in 30d (up to 35): how frequently
 *  - trend (±20): the direction
 *  - recency (±10): how warm the pipeline is right now
 */
export function companyGrowthScore(s: GrowthSignals): number {
  let score = 0;
  score += Math.min(35, s.activeJobs * 4);
  score += Math.min(35, s.newRoles30d * 7);
  if (s.trend === 'GROWING') score += 20;
  else if (s.trend === 'STABLE') score += 10;
  else if (s.trend === 'DECLINING') score -= 5;
  if (s.daysSinceLastJob != null) {
    if (s.daysSinceLastJob <= 7) score += 10;
    else if (s.daysSinceLastJob <= 21) score += 4;
    else if (s.daysSinceLastJob > 60) score -= 10;
  }
  return clamp(score);
}
