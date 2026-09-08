import { isSchedulerWedged, describeWedge } from './queue-health';

/** The real career-extract state, read from Redis on 2026-09-08 15:58 IST. */
const ZOMBIE = {
  nextRunAt: Date.parse('2026-09-04T12:45:00.000Z'),
  workersAttached: 1,
  waiting: 1,
  active: 0,
  now: Date.parse('2026-09-08T10:28:00.000Z'),
};

/** A healthy sibling read in the same snapshot (evaluate-matches). */
const HEALTHY = {
  nextRunAt: Date.parse('2026-09-08T10:33:00.000Z'),
  workersAttached: 1,
  waiting: 0,
  active: 0,
  now: Date.parse('2026-09-08T10:28:00.000Z'),
};

describe('isSchedulerWedged', () => {
  it('FAILS the known zombie: overdue, worker attached, job unclaimed', () => {
    expect(isSchedulerWedged(ZOMBIE)).toBe(true);
  });

  it('PASSES the healthy sibling captured at the same moment', () => {
    expect(isSchedulerWedged(HEALTHY)).toBe(false);
  });

  it('tolerates a tick running slightly late', () => {
    // Ticks drift under load; only a sustained overdue window is a wedge.
    expect(isSchedulerWedged({ ...ZOMBIE, now: ZOMBIE.nextRunAt + 5 * 60_000 })).toBe(false);
  });

  it('does NOT flag a dead process — that is a different fault', () => {
    // workers=0 was the 2026-08-23 failure and is already obvious. Reporting it
    // here would blur two faults with different fixes.
    expect(isSchedulerWedged({ ...ZOMBIE, workersAttached: 0 })).toBe(false);
  });

  it('does NOT flag an overdue schedule with nothing queued', () => {
    // A retired or paused schedule, not a wedge.
    expect(isSchedulerWedged({ ...ZOMBIE, waiting: 0, active: 0 })).toBe(false);
  });

  it('flags a stuck ACTIVE job as well as a stuck WAITING one', () => {
    expect(isSchedulerWedged({ ...ZOMBIE, waiting: 0, active: 1 })).toBe(true);
  });

  it('ignores a queue with no repeatable registered', () => {
    expect(isSchedulerWedged({ ...ZOMBIE, nextRunAt: null })).toBe(false);
  });

  it('describes the wedge for logs, and says nothing when healthy', () => {
    expect(describeWedge('career-extract', ZOMBIE)).toMatch(/WEDGED.*workers=1 waiting=1/);
    expect(describeWedge('evaluate-matches', HEALTHY)).toBe('');
  });
});

/**
 * scanQueue: the queue-agnostic scan. No per-queue thresholds, no lock-duration
 * assumptions — it reads counts, workers and schedulers and applies the same
 * rule to every queue.
 */
import { scanQueue } from './queue-health';

const probe = (counts: Record<string, number>, workers: number, next: number | null) => ({
  getJobCounts: async () => counts,
  getWorkers: async () => Array.from({ length: workers }, (_, i) => i),
  getJobSchedulers: async () => (next === null ? [] : [{ key: 'k', next }]),
});

const NOW = Date.parse('2026-09-08T10:28:00.000Z');

describe('scanQueue', () => {
  it('detects the real career-extract wedge and names the queue', async () => {
    const r = await scanQueue(
      'career-extract',
      probe({ waiting: 1, active: 0 }, 1, Date.parse('2026-09-04T12:45:00.000Z')),
      NOW,
    );
    expect(r.wedged).toBe(true);
    expect(r.message).toContain('career-extract');
  });

  it('does NOT flag replay-extract, which is legitimately idle', async () => {
    // Real values: next fire in the future, no workers busy, nothing queued.
    // An idle queue with no work must never be reported as broken, or the
    // check becomes noise and gets ignored.
    const r = await scanQueue(
      'replay-extract',
      probe({ waiting: 0, active: 0 }, 1, Date.parse('2026-09-09T03:45:00.000Z')),
      NOW,
    );
    expect(r.wedged).toBe(false);
    expect(r.message).toBe('');
  });

  it('does NOT flag render-extract, idle with its next fire ahead', async () => {
    const r = await scanQueue(
      'render-extract',
      probe({ waiting: 0, active: 0 }, 1, Date.parse('2026-09-08T18:45:00.000Z')),
      NOW,
    );
    expect(r.wedged).toBe(false);
  });

  it('ignores a queue with no repeatable registered', async () => {
    const r = await scanQueue('crawl-company', probe({ waiting: 5, active: 1 }, 1, null), NOW);
    expect(r.wedged).toBe(false);
  });

  it('survives a queue that cannot report workers', async () => {
    const p = probe({ waiting: 1, active: 0 }, 1, Date.parse('2026-09-04T12:45:00.000Z'));
    p.getWorkers = async () => { throw new Error('redis hiccup'); };
    // workers falls back to 0, which is the dead-process fault, not a wedge —
    // an inspection failure must not be reported as a wedge.
    const r = await scanQueue('career-extract', p, NOW);
    expect(r.wedged).toBe(false);
  });
});
