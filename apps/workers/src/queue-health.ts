/**
 * Detecting a WEDGED repeatable schedule.
 *
 * On 2026-09-04 06:45 UTC a career-extract job lost its Redis lock mid-run. The
 * job's normal duration (avg 46s, max 185s) exceeded BullMQ's default 30s
 * lockDuration, so every run already depended on uninterrupted renewals; one
 * missed renewal was enough.
 *
 * What followed is the shape this function exists to catch:
 *
 *   Redis   returned the job to WAITING (stalled recovery did its part)
 *   worker  went on believing it still owned the job
 *   slot    concurrency-1 never released, so the waiting job was never claimed
 *   sched   repeatable could not advance past a job it thought was running
 *
 * Nothing errored. `failed` stayed 0. The worker stayed attached and looked
 * healthy. career-extract simply produced 2 runs in 5 days instead of ~20,
 * while writing 18,189 lock-renewal failures nobody was reading.
 *
 * The tell is the COMBINATION, not any single value: a repeatable whose next
 * fire time is in the PAST, a worker attached, and work sitting unclaimed. Each
 * alone is normal — a scheduler between ticks, an idle worker, a queued job.
 */

export interface QueueHealthInput {
  /** ms since epoch of the repeatable's next scheduled fire, or null. */
  nextRunAt: number | null;
  /** Workers currently attached to this queue. */
  workersAttached: number;
  waiting: number;
  active: number;
  /** Evaluated at `now`; injected so the rule is testable without clocks. */
  now: number;
  /**
   * How far past `nextRunAt` counts as wedged. A tick can legitimately be a
   * little late under load; four days cannot.
   */
  graceMs?: number;
}

const DEFAULT_GRACE_MS = 15 * 60 * 1000;

export function isSchedulerWedged(i: QueueHealthInput): boolean {
  if (i.nextRunAt === null) return false; // no repeatable registered
  const overdueBy = i.now - i.nextRunAt;
  if (overdueBy <= (i.graceMs ?? DEFAULT_GRACE_MS)) return false;

  // Overdue with NO worker is a different fault (dead process, as on
  // 2026-08-23) and is already visible as workers=0. This rule targets the
  // harder case: a worker present, and therefore looking fine.
  if (i.workersAttached === 0) return false;

  // Something must actually be stuck. An overdue schedule with an empty queue
  // and an idle worker is a paused or retired schedule, not a wedge.
  return i.waiting > 0 || i.active > 0;
}

/** Human-readable reason, for logs. Empty string when healthy. */
export function describeWedge(name: string, i: QueueHealthInput): string {
  if (!isSchedulerWedged(i)) return '';
  const mins = Math.round((i.now - (i.nextRunAt as number)) / 60000);
  return (
    `[queue-health] ${name} WEDGED: next fire was ${mins} min ago, ` +
    `workers=${i.workersAttached} waiting=${i.waiting} active=${i.active} — ` +
    `a job is unclaimed while a worker is attached`
  );
}

/**
 * Scan every repeatable queue and return the wedged ones.
 *
 * READ-ONLY BY DESIGN. It calls getJobCounts / getWorkers / getJobSchedulers
 * and nothing else: it never restarts, clears, retries, promotes or removes a
 * job. A health check that repairs things hides the very failures it exists to
 * surface, and an automatic retry on a wedged queue would have masked the
 * career-extract stall for another five days.
 *
 * Deliberately run from a plain interval rather than as a BullMQ job: a
 * scheduled job that watches for wedged schedules can itself wedge.
 */
export interface QueueProbe {
  getJobCounts(): Promise<Record<string, number>>;
  getWorkers(): Promise<unknown[]>;
  getJobSchedulers(): Promise<Array<{ key?: string; next?: number }>>;
}

export async function scanQueue(
  name: string,
  q: QueueProbe,
  now = Date.now(),
): Promise<{ name: string; wedged: boolean; message: string }> {
  const [counts, workers, scheds] = await Promise.all([
    q.getJobCounts(),
    q.getWorkers().catch(() => []),
    q.getJobSchedulers().catch(() => []),
  ]);
  // Earliest scheduled fire across this queue's repeatables. A queue with no
  // repeatable is not in scope -- nothing is overdue if nothing is scheduled.
  const nexts = scheds.map((s) => s.next).filter((n): n is number => typeof n === 'number');
  const input = {
    nextRunAt: nexts.length ? Math.min(...nexts) : null,
    workersAttached: workers.length,
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    now,
  };
  return { name, wedged: isSchedulerWedged(input), message: describeWedge(name, input) };
}
