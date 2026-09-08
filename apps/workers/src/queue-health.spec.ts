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
