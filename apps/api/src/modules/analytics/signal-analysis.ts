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
  avgWhenEngaged: number; // avg module score across CLICKED/APPLIED events
  avgWhenDismissed: number; // avg module score across DISMISSED events
  lift: number; // engaged − dismissed: positive = the signal predicts engagement
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
    for (const m of e.breakdown ?? []) {
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
      avgWhenEngaged: e ?? 0,
      avgWhenDismissed: d ?? 0,
      lift: Math.round(((e ?? 0) - (d ?? 0)) * 10) / 10,
      nEngaged: b.engaged.length,
      nDismissed: b.dismissed.length,
    });
  }
  signals.sort((a, b) => b.lift - a.lift);

  return {
    counts,
    avgScore: { engaged: avg(engagedScores), dismissed: avg(dismissedScores) },
    signals,
    sampleSize: engagedScores.length + dismissedScores.length,
  };
}
