/**
 * THE CRAWL RECONCILIATION INVARIANT (P0, 2026-08-16).
 *
 * A crawl may only retire jobs it is actually authoritative for:
 *
 *   1. A crawl that returned NOTHING retires nothing. An empty result is
 *      indistinguishable from a failure, a timeout, a rate limit, a parser
 *      break, a moved page, or an ATS account that exists but is unused.
 *   2. A crawl may only reconcile jobs from ITS OWN source. A Workable board
 *      says nothing about a job discovered through FreeHire.
 *
 * ── What this cost ──────────────────────────────────────────────────────────
 * `syncCompanyJobs` retired every ACTIVE job at a company whose externalId was
 * absent from the current crawl:
 *
 *     const seenIds = jobs.map(j => j.externalId);   // [] when the crawl is empty
 *     where: { companyId, status: ACTIVE, externalId: { notIn: seenIds } }
 *
 * `notIn: []` matches EVERY row, so a crawl that found nothing retired the
 * company's entire board — including jobs from other sources that were never
 * in scope for that crawl.
 *
 * Measured 2026-08-16, after FreeHire discovered 279 new companies:
 *
 *     606 FreeHire jobs REMOVED
 *       86 (14.2%) had a confirmed replacement (same apply URL, live elsewhere)
 *      386 (63.7%) had NO replacement anywhere in the corpus
 *       18 of 31 ACTIONABLE opportunities destroyed, including 4 APPLY
 *          scoring 84.5 - 87.8, higher than anything on the live board
 *
 *     302 of 998 crawl runs that night found zero jobs and retired 406 jobs.
 *     Historically: 2,123 zero-find runs, 683 jobs retired.
 *
 * ── The mechanism, which is NOT an ATS-detection bug ────────────────────────
 * The discovery prober guesses a slug from the company name and probes each
 * ATS API, accepting `Array.isArray(payload.jobs)` as proof of a board. That
 * is true for `[]`. Verified against the live API:
 *
 *     apply.workable.com/api/v1/widget/accounts/zensar   -> 200 {"jobs":[]}
 *     apply.workable.com/api/v1/widget/accounts/nonsense -> 404
 *
 * Zensar genuinely HAS a Workable account; it is simply empty, because their
 * real postings live on Oracle Cloud. So the detector found a real board and
 * the crawler correctly reported zero jobs. The damage came entirely from
 * treating "zero jobs" as "everything else is gone".
 *
 * Notably SmartRecruiters is the one prober validator requiring
 * `totalFound >= 1`, and SmartRecruiters is the one provider with zero
 * board-wiping runs in the audit.
 *
 * Under-retiring is the safe failure: a stale job wastes one evaluation and is
 * visible on the surface. Over-retiring silently deletes opportunities that
 * were already discovered, embedded, scored and recommended.
 */

export interface ReconciliationInput {
  /** externalIds the crawl actually returned. */
  seenExternalIds: string[];
  /** Did the crawl complete successfully? A thrown adapter never reaches here. */
  crawlSucceeded: boolean;
}

export interface ReconciliationDecision {
  /** May this crawl retire absent jobs at all? */
  retire: boolean;
  /** Why not — recorded on the CrawlRun so a skipped reconcile is visible. */
  reason?: 'EMPTY_RESULT' | 'CRAWL_FAILED';
}

/**
 * Decide whether a crawl is authoritative enough to retire absent jobs.
 *
 * Deliberately NOT "did the count drop a lot" — a threshold would still delete
 * on the failure modes that matter and would need tuning. The only signal that
 * cleanly separates "this board is genuinely empty" from every failure mode is
 * whether the crawl returned anything at all, and no source of that evidence
 * exists today. Until it does, an empty crawl retires nothing.
 */
export function decideReconciliation(input: ReconciliationInput): ReconciliationDecision {
  if (!input.crawlSucceeded) return { retire: false, reason: 'CRAWL_FAILED' };
  if (input.seenExternalIds.length === 0) return { retire: false, reason: 'EMPTY_RESULT' };
  return { retire: true };
}
