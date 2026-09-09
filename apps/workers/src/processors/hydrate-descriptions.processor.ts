import type { ApiClient } from '../api-client';
import { fetchHtmlV4 } from './extract-career-pages.processor';
import { decideHydration } from '../adapters/detail-hydration';

/**
 * Detail-page hydration — fetch the posting's own page for jobs whose stored
 * body is too thin to judge.
 *
 * NOT SCHEDULED. Nothing registers this; it is invoked explicitly. Two things
 * must exist before it runs on a timer:
 *
 *   1. ATTEMPT MEMORY. A job whose detail page never yields a body stays in
 *      hydrationDue forever and would consume the batch on every tick — the
 *      2026-08-12 queue-starvation shape exactly. "Persist every decision"
 *      applies to a failed hydration as much as to a verdict.
 *   2. A MEASURED FIRST RUN. The 82-job probe said 77 should hydrate; that
 *      prediction is worth checking against reality before it runs unattended.
 *
 * What it does NOT do, deliberately: no browser, no LLM, no salary/skills/
 * seniority extraction, no new job rows. It recovers a description or it
 * leaves the job exactly as it found it.
 */

const FETCH_TIMEOUT_MS = 12_000;
const PACE_MS = 400;

export interface HydrationOutcome {
  attempted: number;
  fetched: number;
  written: number;
  kept: number;
  fetchFailed: number;
  bySource: Record<string, number>;
}

/**
 * A run that fetched pages and wrote nothing is worth saying out loud: it is
 * what a changed page structure looks like, and it is indistinguishable from
 * "there was nothing to recover" in a bare count.
 */
export function describeHydration(o: HydrationOutcome): string {
  const base =
    `[hydrate] attempted=${o.attempted} fetched=${o.fetched} written=${o.written} ` +
    `kept=${o.kept} fetchFailed=${o.fetchFailed}`;
  return o.fetched > 0 && o.written === 0
    ? `${base} — FETCHED PAGES BUT RECOVERED NOTHING; detail pages may have changed shape`
    : base;
}

export async function hydrateDescriptions(api: ApiClient, limit = 50): Promise<HydrationOutcome> {
  const due = await api.hydrationDue(limit);
  const outcome: HydrationOutcome = {
    attempted: due.length,
    fetched: 0,
    written: 0,
    kept: 0,
    fetchFailed: 0,
    bySource: {},
  };

  // Grouped by source because repairDescriptions matches on (source, externalId).
  const writes = new Map<string, { externalId: string; description: string; descriptionSource: string }[]>();

  for (const job of due) {
    const html = await fetchHtmlV4(job.url, FETCH_TIMEOUT_MS);
    if (html === null) outcome.fetchFailed++;
    else outcome.fetched++;

    const decision = decideHydration(
      { description: job.description, descriptionSource: null },
      html,
    );

    if (decision.action === 'WRITE') {
      const list = writes.get(job.source) ?? [];
      list.push({
        externalId: job.externalId,
        description: decision.description,
        descriptionSource: decision.descriptionSource,
      });
      writes.set(job.source, list);
      outcome.written++;
      outcome.bySource[job.source] = (outcome.bySource[job.source] ?? 0) + 1;
    } else {
      outcome.kept++;
    }

    await new Promise((r) => setTimeout(r, PACE_MS));
  }

  // repairDescriptions clears the embedding on a changed body and re-enqueues
  // it, so the vector is rebuilt from the recovered text. The decision re-opens
  // on its own: INSUFFICIENT_EVIDENCE stops being binding once the body clears
  // MIN_DESCRIPTION_CHARS (see the evidence-invalidation clause in
  // matching.service). Nothing here re-judges anything directly.
  for (const [source, updates] of writes) {
    await api.repairDescriptions(source, updates);
  }

  return outcome;
}
