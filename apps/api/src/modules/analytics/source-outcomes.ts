/**
 * Source → outcome funnel: which acquisition channels actually produce
 * interviews, as opposed to which produce jobs that score well.
 *
 * Reported along TWO axes, because they answer different questions and
 * measuring only the second has already misled us badly:
 *
 *   discoveredBy   who introduced the COMPANY   (companies.discoverySource)
 *   acquiredFrom   where the JOB came from      (jobs.source)
 *
 * Measured 2026-08-21, FreeHire's share of actionable opportunities:
 *   by acquiredFrom   67.1%
 *   by discoveredBy   92.7%
 *
 * The gap is companies FreeHire introduced whose jobs are later crawled from
 * their own ATS. Reading only `acquiredFrom` made the Workday rollout look like
 * diversification while the underlying dependency was essentially unchanged.
 * A funnel that reports one axis is a funnel that will repeat that mistake.
 *
 * Pure and unit-tested; the service supplies rows.
 */
import { isApplied, isInterview, isOffer, MIN_APPLIED_FOR_RATE } from '../applications/status-sets';

/** One outcome event, with both attributions resolved. */
export interface SourceEventInput {
  type: string; // SHOWN | CLICKED | DISMISSED | APPLIED
  discoveredBy: string | null;
  acquiredFrom: string | null;
}

/** One application, with both attributions resolved. */
export interface SourceApplicationInput {
  status: string;
  discoveredBy: string | null;
  acquiredFrom: string | null;
}

export interface SourceFunnelRow {
  source: string;
  shown: number;
  clicked: number;
  dismissed: number;
  applied: number;
  interviews: number;
  offers: number;
  /** clicked / shown — null until anything was shown. */
  ctr: number | null;
  /** applied / shown — null until anything was shown. */
  applyRate: number | null;
  /**
   * interviews / applied — null below MIN_APPLIED_FOR_RATE.
   *
   * This is the number the whole outcome loop exists to produce, which is
   * exactly why it must refuse to answer early. One interview from one
   * application is not a 100% interview rate.
   */
  interviewRate: number | null;
}

export interface SourceOutcomes {
  window: string;
  byDiscovery: SourceFunnelRow[];
  byAcquisition: SourceFunnelRow[];
}

const UNATTRIBUTED = '(unattributed)';
const pct = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : null;

function build(
  events: SourceEventInput[],
  applications: SourceApplicationInput[],
  axis: 'discoveredBy' | 'acquiredFrom',
): SourceFunnelRow[] {
  const rows = new Map<string, SourceFunnelRow>();
  const row = (key: string): SourceFunnelRow => {
    const existing = rows.get(key);
    if (existing) return existing;
    const fresh: SourceFunnelRow = {
      source: key,
      shown: 0, clicked: 0, dismissed: 0, applied: 0, interviews: 0, offers: 0,
      ctr: null, applyRate: null, interviewRate: null,
    };
    rows.set(key, fresh);
    return fresh;
  };

  for (const e of events) {
    const r = row(e[axis] ?? UNATTRIBUTED);
    if (e.type === 'SHOWN') r.shown++;
    else if (e.type === 'CLICKED') r.clicked++;
    else if (e.type === 'DISMISSED') r.dismissed++;
  }

  // `applied` comes from the APPLICATION record, not the APPLIED event: the
  // application is the durable fact a human created, while the event may be
  // missing (an application added straight to the tracker never rendered a
  // card). Counting the event would undercount exactly the applications that
  // matter most — the ones the user pursued deliberately.
  for (const a of applications) {
    const r = row(a[axis] ?? UNATTRIBUTED);
    if (isApplied(a.status)) r.applied++;
    if (isInterview(a.status)) r.interviews++;
    if (isOffer(a.status)) r.offers++;
  }

  for (const r of rows.values()) {
    r.ctr = pct(r.clicked, r.shown);
    r.applyRate = pct(r.applied, r.shown);
    r.interviewRate =
      r.applied >= MIN_APPLIED_FOR_RATE ? pct(r.interviews, r.applied) : null;
  }

  // Interviews first — the outcome that matters — then applications, then
  // impressions. Never by interviewRate: a null rate would sort against real
  // ones, and a 100% rate off two applications would top the table.
  return [...rows.values()].sort(
    (a, b) => b.interviews - a.interviews || b.applied - a.applied || b.shown - a.shown,
  );
}

export function aggregateSourceOutcomes(
  events: SourceEventInput[],
  applications: SourceApplicationInput[],
  window: string,
): SourceOutcomes {
  return {
    window,
    byDiscovery: build(events, applications, 'discoveredBy'),
    byAcquisition: build(events, applications, 'acquiredFrom'),
  };
}
