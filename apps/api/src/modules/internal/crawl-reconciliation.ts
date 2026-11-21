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

/**
 * THE identity rule for one crawl's jobs: a job is its exact `externalId`
 * string (case and whitespace included), and the first occurrence wins. That
 * is the same equality as the `(companyId, externalId)` unique key that the
 * upsert conflicts on.
 *
 * batchUpsert's de-duplication, the drop guard's seen count and the recorded
 * `jobsFound` all go through this one function, so they cannot count
 * differently. A source that lists one posting twice (multi-location
 * postings do this) is one job on every side of the comparison. Empty and
 * missing ids never get this far: the shared NormalizedJob schema requires a
 * non-empty string.
 */
export function firstPerExternalId<T extends { externalId: string }>(
  jobs: readonly T[],
): T[] {
  const seen = new Set<string>();
  return jobs.filter((j) => {
    if (seen.has(j.externalId)) return false;
    seen.add(j.externalId);
    return true;
  });
}

export interface ReconciliationInput {
  /**
   * externalIds the crawl actually returned, one per job: the output of
   * firstPerExternalId. Its length is the crawl's seen count.
   */
  seenExternalIds: readonly string[];
  /** Did the crawl complete successfully? A thrown adapter never reaches here. */
  crawlSucceeded: boolean;
  /**
   * Did the crawl see the WHOLE board? Defaults true — an adapter that cannot
   * paginate always sees all of it. False means the walk stopped short of the
   * listing's end, so absence from `seenExternalIds` proves nothing.
   */
  boardComplete?: boolean;
  /**
   * The drop guard (RETIREMENT_DROP_GUARD). Leave it out when the switch is
   * off: the decision is then exactly the one made before the guard existed.
   */
  dropGuard?: DropGuardInput;
}

export interface DropGuardInput {
  /**
   * The company's previous valid crawl from the same source: SUCCEEDED,
   * complete and non-empty, with `found` its recorded `jobsFound`. `null` when
   * there is none.
   */
  reference: { found: number } | null;
}

export type ReconciliationSkipReason =
  | 'EMPTY_RESULT'
  | 'CRAWL_FAILED'
  | 'PARTIAL_BOARD'
  | 'NO_REFERENCE'
  | 'SUDDEN_DROP';

export interface ReconciliationDecision {
  /** May this crawl retire absent jobs at all? */
  retire: boolean;
  /** Why not. Logged, and visible on the run as `reconciled = false`. */
  reason?: ReconciliationSkipReason;
}

/**
 * Rule B of the drop guard: this crawl saw fewer than half as many jobs as the
 * previous valid crawl. Exactly half still retires. Integer arithmetic, so an
 * odd reference needs no rounding: against 101, 50 is a drop and 51 is not.
 */
export function isSuddenDrop(
  seenCount: number,
  referenceFound: number,
): boolean {
  return 2 * seenCount < referenceFound;
}

/**
 * Decide whether a crawl is authoritative enough to retire absent jobs.
 *
 * The first three refusals need no history. An empty result is the one signal
 * that cleanly separates "this board is genuinely empty" from every failure
 * mode, so it never retires anything, whatever came before.
 *
 * The drop guard adds two refusals that compare this crawl with the company's
 * previous valid crawl. A count threshold alone could not be trusted to decide
 * a deletion, and before crawl runs recorded whether a walk was complete there
 * was no reliable earlier count to compare with. The guard therefore only ever
 * DEFERS: a crawl that saw less than half of the previous valid crawl retires
 * nothing, and it becomes the reference for the next crawl. A short response
 * that persists is retired one crawl late; one that rebounds retires nothing.
 * A wrong deferral costs one crawl of delay, and a missed drop is no worse than
 * having no guard.
 *
 * Its known limit: it compares neighbouring crawls only, so a board that
 * shrinks by less than half at every step is never deferred.
 */
export function decideReconciliation(input: ReconciliationInput): ReconciliationDecision {
  if (!input.crawlSucceeded) return { retire: false, reason: 'CRAWL_FAILED' };
  if (input.seenExternalIds.length === 0) return { retire: false, reason: 'EMPTY_RESULT' };
  // GUARD 3 (2026-08-21). A truncated walk is a SUCCESSFUL, NON-EMPTY crawl —
  // it passes both guards above and then retires the entire tail it never
  // reached. Workday caps at 25 pages (500 listings); 5 of the 9 canary tenants
  // hit that cap, and Accenture holds ~43k India postings behind it. Nothing
  // has fired yet only because the canary was the FIRST crawl, with nothing to
  // retire; the second one is where the tail disappears.
  //
  // Found by reading FreeHire's crawlAllPagedLinks, which inverts its own
  // page-failure rule for exactly this reason: where a sweep is catalogue-
  // scoped, a silently short walk "looks like a shrunken catalogue and would
  // mass-close every posting past the failed page".
  if (input.boardComplete === false) return { retire: false, reason: 'PARTIAL_BOARD' };
  if (input.dropGuard) {
    const { reference } = input.dropGuard;
    if (reference === null) return { retire: false, reason: 'NO_REFERENCE' };
    if (isSuddenDrop(input.seenExternalIds.length, reference.found)) {
      return { retire: false, reason: 'SUDDEN_DROP' };
    }
  }
  return { retire: true };
}
