/**
 * Outcome analysis — the payoff of the append-only opportunity-event log. Given
 * events that each snapshot the score breakdown at the moment of a user action,
 * it answers the question the whole Validation phase exists to answer: which
 * signals actually separate the jobs a user engages with from the ones they
 * dismiss? Pure and unit-tested; the service just feeds it rows.
 */

export interface BreakdownModule {
  module: string;
  score: number;
  weight: number;
  reason?: string;
}

export interface OppEventInput {
  type: string; // VIEWED | CLICKED | DISMISSED | APPLIED
  opportunityScore: number | null;
  breakdown: BreakdownModule[] | null;
}

export interface SignalLift {
  module: string;
  /** avg module score across CLICKED/APPLIED events; null if never observed there */
  avgWhenEngaged: number | null;
  /** avg module score across DISMISSED events; null if never observed there */
  avgWhenDismissed: number | null;
  /**
   * engaged − dismissed: positive = the signal predicts engagement.
   *
   * null unless BOTH sides were actually observed. A module seen only in
   * clicks has no measured lift, and substituting 0 for the unobserved side
   * would read "never dismissed" as "scores 0 when dismissed" — manufacturing
   * maximum lift out of no counter-evidence. UNKNOWN ≠ LOW applies to the
   * measurements as much as to the scores.
   */
  lift: number | null;
  nEngaged: number;
  nDismissed: number;
}

export interface SignalOutcome {
  counts: Record<string, number>;
  avgScore: { engaged: number | null; dismissed: number | null };
  signals: SignalLift[];
  sampleSize: number;
}

const ENGAGED = new Set(['CLICKED', 'APPLIED']);
const avg = (xs: number[]): number | null =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;

export interface RecommendationQuality {
  shown: number;
  clicked: number;
  dismissed: number;
  applied: number;
  ctr: number | null; // clicked / shown
  applyRate: number | null; // applied / shown
  dismissRate: number | null; // dismissed / shown
  avgScoreApplied: number | null;
  avgScoreDismissed: number | null;
}

const pct = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : null;

/**
 * Product-level funnel: from impressions to clicks to applies, plus the score
 * separation between applied and dismissed. This is the "are the recommendations
 * any good?" read that a system-metrics dashboard can't give.
 */
export function recommendationQuality(events: OppEventInput[]): RecommendationQuality {
  const counts: Record<string, number> = {};
  const appliedScores: number[] = [];
  const dismissedScores: number[] = [];
  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'APPLIED' && e.opportunityScore != null) appliedScores.push(e.opportunityScore);
    if (e.type === 'DISMISSED' && e.opportunityScore != null)
      dismissedScores.push(e.opportunityScore);
  }
  const shown = counts['SHOWN'] ?? 0;
  return {
    shown,
    clicked: counts['CLICKED'] ?? 0,
    dismissed: counts['DISMISSED'] ?? 0,
    applied: counts['APPLIED'] ?? 0,
    ctr: pct(counts['CLICKED'] ?? 0, shown),
    applyRate: pct(counts['APPLIED'] ?? 0, shown),
    dismissRate: pct(counts['DISMISSED'] ?? 0, shown),
    avgScoreApplied: avg(appliedScores),
    avgScoreDismissed: avg(dismissedScores),
  };
}

export function aggregateSignalOutcomes(events: OppEventInput[]): SignalOutcome {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;

  const engagedScores: number[] = [];
  const dismissedScores: number[] = [];
  // module -> { engaged: number[], dismissed: number[] }
  const byModule = new Map<string, { engaged: number[]; dismissed: number[] }>();

  for (const e of events) {
    const engaged = ENGAGED.has(e.type);
    const dismissed = e.type === 'DISMISSED';
    if (!engaged && !dismissed) continue; // VIEWED is a neutral impression here
    if (e.opportunityScore != null) {
      (engaged ? engagedScores : dismissedScores).push(e.opportunityScore);
    }
    // Array.isArray, not `?? []`: this originates in a JSON column, where a
    // null guard alone still lets an object through to be iterated.
    for (const m of Array.isArray(e.breakdown) ? e.breakdown : []) {
      const bucket = byModule.get(m.module) ?? { engaged: [], dismissed: [] };
      (engaged ? bucket.engaged : bucket.dismissed).push(m.score);
      byModule.set(m.module, bucket);
    }
  }

  const signals: SignalLift[] = [];
  for (const [module, b] of byModule) {
    const e = avg(b.engaged);
    const d = avg(b.dismissed);
    signals.push({
      module,
      avgWhenEngaged: e,
      avgWhenDismissed: d,
      lift: e != null && d != null ? Math.round((e - d) * 10) / 10 : null,
      nEngaged: b.engaged.length,
      nDismissed: b.dismissed.length,
    });
  }
  // Measured lift ranks first, descending. Unmeasured modules sort last, by
  // how much evidence they have: an absent lift must never outrank a real one.
  signals.sort((a, b) => {
    if (a.lift != null && b.lift != null) return b.lift - a.lift;
    if (a.lift != null) return -1;
    if (b.lift != null) return 1;
    return b.nEngaged + b.nDismissed - (a.nEngaged + a.nDismissed);
  });

  return {
    counts,
    avgScore: { engaged: avg(engagedScores), dismissed: avg(dismissedScores) },
    signals,
    sampleSize: engagedScores.length + dismissedScores.length,
  };
}
