/**
 * THE canonical pipeline decision version.
 *
 * `job_matches.decisionVersion` answers exactly one question: *was this
 * decision produced by the pipeline that is running now?* The candidate query
 * in `reconcileForUser` excludes a job only when the answer is yes, so every
 * writer of a terminal decision must stamp this same number.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * It did not, until 2026-08-15, and two writers stamped the column with two
 * different constants:
 *
 *   matching.service.recordGateRejections  →  CLASSIFIER_VERSION  = 2
 *   opportunity.service.scoreAndPersist    →  DECISION_VERSION    = 1
 *
 * while the exclusion predicate tested `>= CLASSIFIER_VERSION`. The result was
 * exactly inverted from what anyone wanted: decisions that cost nothing stuck
 * forever, and decisions that cost an LLM call did not.
 *
 *   gate-refused (free)      → stamped 2 → excluded    ✅
 *   deep-scored ($0.0147)    → stamped 1 → re-admitted ❌
 *
 * Measured before the fix: the belt re-judged the same 89 jobs every 10-minute
 * tick — `decided_total` sat at 1,488 across a full tick while spend rose
 * $0.2156, about $1.29/hour for zero new decisions. Because those jobs occupied
 * the top of the candidate ordering under LIMIT, the 4,908-job tier-0 backlog
 * behind them was unreachable. Not a slowdown: a hard stall.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 * Every terminal decision is persisted with the current pipeline version, and
 * every consumer respects that version. This is the third incarnation of the
 * same underlying bug (see CLAUDE.md invariant #5, and the 2026-08-12 queue
 * starvation incident): the system decides something and then fails to
 * remember it correctly. The failure mode is always silent and always
 * expensive — repeated LLM spend, duplicate applications, repeated
 * notifications, jobs reappearing, wrong analytics.
 *
 * ── Bumping it ──────────────────────────────────────────────────────────────
 * Raise this when a change should invalidate STORED DECISIONS: the classifier
 * taxonomy, the eligibility gate, or decide()'s verdict logic. Every existing
 * decision below the new number re-opens and is judged again, which costs real
 * money — roughly $0.0147 per job that passes the gate. It is deliberately not
 * derived from CLASSIFIER_VERSION: that number versions a JD's *classification
 * row*, a different question with a different lifetime.
 *
 * Held at 2 rather than raised to 3 during the fix, so the 1,198 correctly
 * stamped gate refusals stayed valid and only the 290 spinning deep-scored
 * rows re-opened — a one-time correction of about $4 instead of $20.
 *
 * This file imports nothing on purpose. `matching.service` imports
 * `OpportunityService` and `opportunity.service` imports from `matching/`, so
 * anything with dependencies would close that cycle at module-load time.
 */
export const PIPELINE_DECISION_VERSION = 2;
