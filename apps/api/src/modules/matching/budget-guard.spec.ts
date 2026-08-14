/**
 * Regression suite for the AI budget guard (2026-08-15).
 *
 * The evaluation belt runs unattended every 15 minutes, forever. It is funded
 * by a GCP free credit (₹23,435 of ₹28,320.75 remaining, ~$248) that EXPIRES
 * 2026-10-07. On 8 October nothing about the belt changes — the same ticks
 * simply start charging the attached card. The account is already flagged
 * "paid ... will accrue a balance", so there is no hard stop from Google.
 *
 * A ceiling is what turns that date into a stopped queue rather than a
 * surprise invoice. These tests pin the decision itself.
 */

/** Mirrors dailyBudgetUsd() in MatchingService. */
function dailyBudgetUsd(raw: string | undefined): number {
  const v = raw?.trim();
  if (!v) return 8;
  const parsed = Number(v);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 8;
}

/** Mirrors the guard at the top of reconcileAll(). */
function shouldSkip(spentUsd: number, budgetUsd: number): boolean {
  return spentUsd >= budgetUsd;
}

describe('AI daily budget guard', () => {
  describe('budget resolution', () => {
    it('defaults to $8/day when unset', () => {
      expect(dailyBudgetUsd(undefined)).toBe(8);
    });

    it('reads a configured ceiling', () => {
      expect(dailyBudgetUsd('25')).toBe(25);
    });

    it('honours 0 as "pause evaluation entirely", not as "unset"', () => {
      // The dangerous confusion: falling back to the default here would keep
      // spending exactly when someone tried to stop it.
      expect(dailyBudgetUsd('0')).toBe(0);
    });

    it('falls back to the default on garbage rather than spending freely', () => {
      expect(dailyBudgetUsd('abc')).toBe(8);
      expect(dailyBudgetUsd('-5')).toBe(8);
    });

    it('treats an EMPTY value as unset, not as 0', () => {
      // Number('') === 0, so a naive parse lets a blank or deleted env var
      // silently pause the belt — indistinguishable from having nothing left
      // to judge. A typo must not stop evaluation; only an explicit 0 may.
      expect(dailyBudgetUsd('')).toBe(8);
      expect(dailyBudgetUsd('   ')).toBe(8);
    });
  });

  describe('the skip decision', () => {
    it('runs while under budget', () => {
      expect(shouldSkip(3.2, 8)).toBe(false);
    });

    it('stops exactly AT the ceiling, not after passing it', () => {
      expect(shouldSkip(8, 8)).toBe(true);
    });

    it('stops when over', () => {
      expect(shouldSkip(9.5, 8)).toBe(true);
    });

    it('a zero budget stops everything, including a zero-spend day', () => {
      // Pausing must work from a cold start, not only once money is spent.
      expect(shouldSkip(0, 0)).toBe(true);
    });

    it('runs on a fresh day with no spend', () => {
      expect(shouldSkip(0, 8)).toBe(false);
    });
  });

  describe('projected spend stays inside the ceiling', () => {
    // Real numbers: $0.0147/LLM item measured from ai_usage, ~57% of candidates
    // reach the LLM (cap=60 tick scored 34), 4 ticks/hour.
    const COST_PER_ITEM = 0.0147;
    const LLM_FRACTION = 0.57;
    const TICKS_PER_DAY = 96;

    const dailyCost = (cap: number) => cap * LLM_FRACTION * COST_PER_ITEM * TICKS_PER_DAY;

    it('cap=100 running flat out would exceed $8, so the guard binds', () => {
      // This is the point: at full drain the belt WOULD overshoot, and the
      // guard — not luck — is what stops it.
      expect(dailyCost(100)).toBeGreaterThan(8);
    });

    it('steady state (a few hundred fresh jobs/day) stays well under', () => {
      // ~488 eligible arrivals/day measured, not 9,600 candidates.
      const steadyStateItems = 488 * LLM_FRACTION;
      expect(steadyStateItems * COST_PER_ITEM).toBeLessThan(8);
    });
  });
});
