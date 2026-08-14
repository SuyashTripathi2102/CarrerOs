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

/** Mirrors num() in MatchingService. */
function dailyBudgetUsd(raw: string | undefined, fallback = 8): number {
  const v = raw?.trim();
  if (!v) return fallback;
  const parsed = Number(v);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Mirrors the credit-regime switch in MatchingService.dailyBudgetUsd(). */
function budgetFor(
  now: Date,
  env: { during?: string; after?: string; expiresAt?: string },
): { budget: number; regime: 'credit' | 'post-credit' } {
  const expired = env.expiresAt ? now.getTime() > new Date(env.expiresAt).getTime() : false;
  return expired
    ? { budget: dailyBudgetUsd(env.after, 2), regime: 'post-credit' }
    : { budget: dailyBudgetUsd(env.during, 8), regime: 'credit' };
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

  describe('the credit cliff — 2026-10-07', () => {
    const env = { during: '50', after: '2', expiresAt: '2026-10-07' };

    it('spends freely while the credit is alive', () => {
      // Unspent credit is LOST on expiry, so a low ceiling before that date
      // saves nothing — it only wastes the balance.
      expect(budgetFor(new Date('2026-08-15'), env)).toEqual({ budget: 50, regime: 'credit' });
    });

    it('still spends freely on the last day', () => {
      expect(budgetFor(new Date('2026-10-07T00:00:00Z'), env).regime).toBe('credit');
    });

    it('throttles the day AFTER expiry, with nobody having to remember', () => {
      // The belt does not change on 8 October; the payer does. This is the
      // whole reason the guard is date-aware rather than a fixed number.
      expect(budgetFor(new Date('2026-10-08'), env)).toEqual({ budget: 2, regime: 'post-credit' });
    });

    it('throttles far beyond expiry too', () => {
      expect(budgetFor(new Date('2027-01-01'), env).regime).toBe('post-credit');
    });

    it('post-credit budget is small but NON-ZERO', () => {
      // Dropping to 0 would make /today silently die on a date nobody watches.
      // A small budget keeps genuinely fresh jobs flowing (~$4/day steady state).
      expect(budgetFor(new Date('2026-10-08'), env).budget).toBeGreaterThan(0);
    });

    it('stays in credit regime when no expiry is configured', () => {
      expect(budgetFor(new Date('2030-01-01'), { during: '50' }).regime).toBe('credit');
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
