import { Worker, Queue } from 'bullmq';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';
import { ApiClient } from '../api-client';

/**
 * The evaluation conveyor belt.
 *
 * Until 2026-08-15 CareerOS had an automated intake bolted to a hand-cranked
 * judgement step: discovery ran on repeatable schedules (refresh-all 15m,
 * discovery-fanout 10m, boards daily) while matching ran ONLY on resume
 * activation or a manual `POST /internal/matches/reconcile`. The funnel showed
 * the cost precisely:
 *
 *   eligible pool (ACTIVE + India/remote + <=45d + embedded + sim >= 0.45)  7,409
 *   judged                                                                     89
 *   NEVER LOOKED AT                                                         7,320  = 98.8%
 *
 * Those were not rejections. They were unopened envelopes — and no amount of
 * extra discovery could help while nothing asked the evaluator to run. That
 * endpoint's own docstring already said "called after a resume re-parse and on
 * a schedule"; the schedule was simply never registered.
 *
 * Deliberately a CONVEYOR BELT, not a drain:
 *   - a fixed batch per tick, so spend is predictable and there is no single
 *     large LLM bill
 *   - `reconcileForUser` already excludes anything decided under the current
 *     classifier, so ticks never re-judge the same job
 *   - candidates are ordered FRESH-FIRST, so a job posted an hour ago is judged
 *     before a 40-day-old listing whatever their similarity
 *   - the backlog drains as a side effect of steady operation
 */
export interface EvaluateMatchesJobData {
  /** Per-user batch size for this tick. Higher = faster drain, more spend. */
  cap?: number;
}

/**
 * Per-user candidates evaluated per tick. At 15m ticks this is the throttle.
 *
 * 100 measured against a 900s window: a cap=60 tick took 264s, so 100 lands
 * near 440s — comfortably inside, with room for a slow LLM day. 150 would risk
 * overrunning the window and stacking ticks.
 *
 * Sized to the funding, not to the hardware: the GCP free credit paying for
 * this (~$248 remaining) expires 2026-10-07, and running slower than this
 * would simply leave credit unspent when it evaporates. Spend is bounded
 * independently by the API's daily budget guard (AI_DAILY_BUDGET_USD), which
 * is what keeps the belt safe after that date.
 */
const DEFAULT_CAP = 100;

export function startEvaluateMatchesWorker(api: ApiClient): Worker {
  return new Worker<EvaluateMatchesJobData>(
    QueueNames.EVALUATE_MATCHES,
    async (job) => {
      const cap = job.data?.cap ?? DEFAULT_CAP;
      const started = Date.now();
      const res = await api.reconcileMatches(cap);
      const seconds = Math.round((Date.now() - started) / 1000);

      // Logged every tick because this is the number that answers "why so few
      // jobs?" — a belt that silently stops looks identical to a belt with
      // nothing left to do. The budget skip is called out explicitly for the
      // same reason: a paused belt must never be mistaken for an idle one.
      if (res.skipped) {
        console.warn(`[evaluate-matches] SKIPPED — ${res.skipped}`);
      } else {
        console.log(
          `[evaluate-matches] cap=${cap} users=${res.users} scored=${res.scored} apply=${res.apply} in ${seconds}s`,
        );
      }
      return res;
    },
    {
      connection: createRedisConnection(),
      // One tick at a time. Overlapping reconciles would double-spend on the
      // same candidates: a job is only excluded once its decision is written.
      concurrency: 1,
    },
  );
}

/**
 * Idempotent scheduler.
 *
 * 10 minutes, not 15: a cap=100 tick measures ~440s, so a 15-minute cadence
 * left the belt idle roughly half the time while a 4,900-job tier-0 backlog
 * waited. At 10 minutes it runs near-continuously during a drain (~820
 * candidates/hour) and costs nothing once caught up, because a tick with no
 * unjudged candidates returns immediately.
 *
 * Overlap is harmless by construction: concurrency is 1, so a tick queued while
 * another is running simply waits its turn rather than double-spending. Spend
 * is bounded by the API's daily budget guard, not by this interval.
 */
export async function ensureEvaluateMatchesSchedule(): Promise<void> {
  const queue = new Queue<EvaluateMatchesJobData>(QueueNames.EVALUATE_MATCHES, {
    connection: createRedisConnection(),
  });
  // Retire the previous cadence, or both schedulers fire.
  await queue.removeJobScheduler('evaluate-matches-15m').catch(() => undefined);
  await queue.upsertJobScheduler(
    'evaluate-matches-10m',
    { every: 10 * 60 * 1000 },
    {
      name: 'scheduled',
      data: { cap: DEFAULT_CAP },
      opts: {
        // No retries: the next tick is 15 minutes away and picks up exactly the
        // same candidates. Retrying a partially-spent batch just pays twice.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    },
  );
  await queue.close();
  console.log(`[scheduler] evaluate-matches: 10m (cap=${DEFAULT_CAP}/user/tick)`);
}
