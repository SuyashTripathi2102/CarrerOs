/**
 * Regression suite for evaluation ordering (2026-08-15).
 *
 * The funnel measurement found 7,320 of 7,409 eligible jobs (98.8%) had never
 * been judged — not rejected, never looked at — because matching had no
 * scheduler while discovery ticked every 10-15 minutes.
 *
 * Turning evaluation into a conveyor belt makes ORDER matter for the first
 * time. Previously candidates were ranked purely by similarity, so a 40-day-old
 * listing at 0.85 was evaluated ahead of a job posted 30 minutes ago at 0.80.
 * Since the belt eventually judges everything, order controls LATENCY, not
 * verdicts — and a fresh job is worth more because it is still open and has had
 * fewer applicants.
 *
 * These tests pin the tier function that the candidate SQL implements:
 *
 *   ORDER BY CASE WHEN age <= 7 THEN 0 WHEN age <= 14 THEN 1 ELSE 2 END,
 *            vector <=> resume_vector
 */

/** Mirrors the CASE expression in reconcileForUser's candidate query. */
function freshnessTier(ageDays: number): 0 | 1 | 2 {
  if (ageDays <= 7) return 0;
  if (ageDays <= 14) return 1;
  return 2;
}

/** Mirrors the full ORDER BY: tier first, then cosine distance (lower = nearer). */
function candidateOrder(
  a: { ageDays: number; distance: number },
  b: { ageDays: number; distance: number },
): number {
  const byTier = freshnessTier(a.ageDays) - freshnessTier(b.ageDays);
  return byTier !== 0 ? byTier : a.distance - b.distance;
}

describe('evaluation candidate ordering', () => {
  describe('freshness tiers', () => {
    it.each([
      [0, 0],
      [1, 0],
      [7, 0],
      [8, 1],
      [14, 1],
      [15, 2],
      [45, 2],
    ])('age %i days -> tier %i', (age, tier) => {
      expect(freshnessTier(age)).toBe(tier);
    });
  });

  it('judges a fresh job before an older, more similar one', () => {
    // The exact inversion this change exists to fix.
    const fresh = { ageDays: 0, distance: 0.2 }; // similarity 0.80, posted today
    const stale = { ageDays: 40, distance: 0.15 }; // similarity 0.85, 40 days old
    expect([stale, fresh].sort(candidateOrder)[0]).toBe(fresh);
  });

  it('still prefers the closer match WITHIN a tier', () => {
    // Freshness decides the tier; similarity decides the order inside it.
    const closer = { ageDays: 3, distance: 0.15 };
    const further = { ageDays: 1, distance: 0.30 };
    expect([further, closer].sort(candidateOrder)[0]).toBe(closer);
  });

  it('orders across all three tiers', () => {
    const sorted = [
      { ageDays: 30, distance: 0.10 },
      { ageDays: 10, distance: 0.25 },
      { ageDays: 2, distance: 0.40 },
    ].sort(candidateOrder);
    expect(sorted.map((c) => c.ageDays)).toEqual([2, 10, 30]);
  });

  it('does not starve the older tier — it is ordered last, never excluded', () => {
    // A conveyor belt must still reach the backlog. Tier 2 jobs are deprioritized
    // for latency, NOT filtered out; the 45-day cutoff is the only exclusion.
    const all = [
      { ageDays: 44, distance: 0.5 },
      { ageDays: 1, distance: 0.5 },
    ].sort(candidateOrder);
    expect(all).toHaveLength(2);
    expect(all[1].ageDays).toBe(44);
  });

  it('is a total order — equal tier and distance compare equal', () => {
    expect(candidateOrder({ ageDays: 2, distance: 0.2 }, { ageDays: 5, distance: 0.2 })).toBe(0);
  });
});
