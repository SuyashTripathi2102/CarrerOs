import { byRecommendation, recommendationState, type RecommendationState } from './matching.service';

/**
 * Regression suite for the recommendation-integrity failure (2026-08-14).
 *
 * CareerOS had two functions both named "Opportunity Score": the persisted
 * 10-module decision engine (ADR-10) and a 7-signal additive surface score that
 * ran NO eligibility gate. /today and /browse rendered the second, so:
 *
 *   - 15 of the top 100 were jobs the gate had explicitly REFUSED, shown as
 *     "Apply" — e.g. "Apply to XO Health — Opportunity 71" for a job recorded
 *     as TARGET_ROLE_TOO_SENIOR ("senior role — beyond 2 years of experience").
 *   - 67 of the top 100 had never been evaluated at all, yet carried a
 *     confident-looking number.
 *   - 6 of the 7 APPLY jobs (74–92) were BELOW the surface pool's 0.8037
 *     similarity cutoff and could not be displayed at all.
 *
 * These tests pin the boundary: what CareerOS is allowed to claim about a job
 * depends on what the decision engine actually decided.
 */
describe('recommendationState', () => {
  const decided = new Date('2026-08-14T10:00:00Z');

  describe('the gate is authoritative, never decorative', () => {
    // Every refusal code observed in production. A job carrying one of these
    // must never reach an actionable surface, whatever its similarity.
    const refusals = [
      'TARGET_ROLE_TOO_SENIOR',
      'NOT_DEVELOPMENT',
      'DEVELOPMENT_WRONG_SPECIALIZATION',
      'TARGET_ROLE_BELOW_LEVEL',
      'LOW_CODING_RESPONSIBILITY',
      'CORE_STACK_MISMATCH',
    ];

    it.each(refusals)('refuses %s', (code) => {
      expect(recommendationState('SKIP', code, decided)).toBe('REFUSED');
    });

    it('refuses a gate-rejected job even if the verdict field says APPLY', () => {
      // Defence in depth: the code is the gate's own record. If the two ever
      // disagree, refuse — never upgrade a refusal into a recommendation.
      expect(recommendationState('APPLY', 'TARGET_ROLE_TOO_SENIOR', decided)).toBe('REFUSED');
    });

    it('reproduces the XO Health case exactly', () => {
      expect(recommendationState('SKIP', 'TARGET_ROLE_TOO_SENIOR', decided)).toBe('REFUSED');
    });
  });

  describe('UNKNOWN is not REFUSED', () => {
    it('treats a never-evaluated job as POTENTIAL, not REFUSED', () => {
      // The jobgether case: shown at rank #1 as "Opportunity 72" with no match.
      expect(recommendationState(null, null, null)).toBe('POTENTIAL');
    });

    it('treats an undecided row as POTENTIAL even if a verdict is present', () => {
      // A verdict without decidedAt is not a decision the surface may act on.
      expect(recommendationState('APPLY', 'TARGET_ROLE_ELIGIBLE', null)).toBe('POTENTIAL');
    });

    it('does not let an unevaluated job become APPLY', () => {
      expect(recommendationState(null, null, null)).not.toBe('APPLY');
    });
  });

  describe('evaluated decisions pass through', () => {
    it('APPLY stays APPLY', () => {
      expect(recommendationState('APPLY', 'TARGET_ROLE_ELIGIBLE', decided)).toBe('APPLY');
    });

    it('CONSIDER stays CONSIDER', () => {
      expect(recommendationState('CONSIDER', 'TARGET_ROLE_EXPERIENCE_STRETCH', decided)).toBe(
        'CONSIDER',
      );
    });

    it('a plain SKIP (score below bar, not a gate refusal) is still REFUSED', () => {
      expect(recommendationState('SKIP', 'SCORE_BELOW_BAR', decided)).toBe('REFUSED');
    });
  });
});

describe('byRecommendation ordering', () => {
  const item = (state: RecommendationState, opportunity: number | null, matchSignal: number) => ({
    state,
    opportunity,
    matchSignal,
  });

  it('puts an evaluated APPLY above a higher-signal POTENTIAL', () => {
    // The core inversion: a similarity-only candidate must never outrank a job
    // the decision engine approved. fff0bd97 (APPLY 92.1, similarity 0.78) was
    // losing to unevaluated jobs at 0.84.
    const apply = item('APPLY', 92.1, 54);
    const potential = item('POTENTIAL', null, 72);
    expect([potential, apply].sort(byRecommendation)[0]).toBe(apply);
  });

  it('orders evaluated jobs by the canonical score, not the signal', () => {
    const better = item('APPLY', 92.1, 40);
    const worse = item('APPLY', 78.3, 70);
    expect([worse, better].sort(byRecommendation)[0]).toBe(better);
  });

  it('orders POTENTIAL by match signal, since no canonical score exists', () => {
    const strong = item('POTENTIAL', null, 72);
    const weak = item('POTENTIAL', null, 65);
    expect([weak, strong].sort(byRecommendation)[0]).toBe(strong);
  });

  it('ranks APPLY above CONSIDER above POTENTIAL', () => {
    const sorted = [
      item('POTENTIAL', null, 99),
      item('CONSIDER', 65, 10),
      item('APPLY', 76, 10),
    ].sort(byRecommendation);
    expect(sorted.map((i) => i.state)).toEqual(['APPLY', 'CONSIDER', 'POTENTIAL']);
  });

  it('never promotes a null opportunity above a real one within evaluated states', () => {
    const real = item('APPLY', 80, 0);
    const missing = item('APPLY', null, 100);
    expect([missing, real].sort(byRecommendation)[0]).toBe(real);
  });
});
