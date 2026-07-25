/**
 * Opportunity Score — the central ranking intelligence. Resume fit alone is not
 * how good an opportunity is: a 92% match with no referral, posted 40 days ago,
 * is worse than an 84% match at a watched company, posted today, where a
 * referral is already in flight. This blends the evidence CareerOS already has
 * into one honest 0–100, with the contributing factors exposed so the ranking
 * is explainable. Deterministic — no LLM.
 */

export type ReferralState = 'CONTACTED' | 'FOUND' | 'NONE';
export type HiringTrend = 'GROWING' | 'STABLE' | 'DECLINING' | 'INSUFFICIENT_DATA' | null;

export interface OppSignals {
  resumeFit: number; // 0–100 (embedding similarity)
  ageDays: number | null; // posting age
  referral: ReferralState;
  watched: boolean; // company on the user's watchlist
  hiringTrend: HiringTrend;
  applied: boolean;
}

export interface OppFactor {
  label: string;
  delta: number; // points contributed (may be negative)
}

export interface Opportunity {
  score: number; // 0–100
  competition: 'LOW' | 'MEDIUM' | 'HIGH'; // proxy from freshness — fewer applicants when fresh
  factors: OppFactor[]; // sorted by magnitude, biggest first
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** Freshness → competition: newer postings have had fewer applicants. */
export function competitionFromAge(ageDays: number | null): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (ageDays == null) return 'MEDIUM';
  if (ageDays <= 2) return 'LOW';
  if (ageDays <= 10) return 'MEDIUM';
  return 'HIGH';
}

export function opportunityScore(s: OppSignals): Opportunity {
  const factors: OppFactor[] = [];
  const add = (label: string, delta: number) => {
    if (delta !== 0) factors.push({ label, delta: Math.round(delta) });
  };

  // Resume fit is the base. Similarity clusters ~55–92, so stretch that band
  // across most of the score (fit 90 ≈ 68 pts, 72 ≈ 33, ≤55 ≈ 0).
  const fitPoints = clamp(((s.resumeFit - 55) / 35) * 68, 0, 68);
  add(`Resume fit ${Math.round(s.resumeFit)}%`, fitPoints);

  // Freshness — apply while it's warm; decay when stale.
  if (s.ageDays != null) {
    if (s.ageDays <= 1) add('Posted today', 12);
    else if (s.ageDays <= 3) add('Fresh (<3 days)', 9);
    else if (s.ageDays <= 7) add('Recent (<1 week)', 5);
    else if (s.ageDays > 45) add('Old posting', -8);
    else if (s.ageDays > 21) add('Ageing posting', -4);
  }

  // Referral — the single biggest real-world lever on getting seen.
  if (s.referral === 'CONTACTED') add('Referral in flight', 12);
  else if (s.referral === 'FOUND') add('Referral available', 6);

  if (s.watched) add('On your watchlist', 8);

  if (s.hiringTrend === 'GROWING') add('Company hiring is growing', 5);
  else if (s.hiringTrend === 'DECLINING') add('Company hiring is slowing', -3);

  // Already applied — keep it visible but sink it so fresh leads rise.
  if (s.applied) add('Already applied', -18);

  const score = clamp(factors.reduce((sum, f) => sum + f.delta, 0));
  factors.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { score, competition: competitionFromAge(s.ageDays), factors };
}
