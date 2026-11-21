const mockUpsert = jest.fn((..._args: unknown[]) => Promise.resolve());

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    upsertJobScheduler: mockUpsert,
    close: () => Promise.resolve(),
  })),
  Worker: jest.fn(),
}));
jest.mock('../queues/connection', () => ({ createRedisConnection: () => ({}) }));

// The same parser and version BullMQ uses to compute the next run.
import { parseExpression } from 'cron-parser';
import { ensureDailyBriefSchedule } from './daily-brief.processor';

/**
 * The brief was labelled "02:30 UTC = 08:00 IST" but BullMQ read the pattern in
 * server-local time, so on the IST laptop it fired at 02:30 IST (measured from
 * source_trust.computedAt, which the brief refreshes just before sending).
 */
describe('daily brief schedule', () => {
  beforeAll(async () => {
    mockUpsert.mockClear();
    await ensureDailyBriefSchedule();
  });

  const repeatFor = (id: string) =>
    mockUpsert.mock.calls.find((c) => c[0] === id)?.[1] as { pattern: string; tz?: string };

  const nextUtcHourMinute = (repeat: { pattern: string; tz?: string }) => {
    const next = parseExpression(repeat.pattern, {
      tz: repeat.tz,
      currentDate: new Date('2026-11-10T00:00:00Z'),
    })
      .next()
      .toDate();
    return `${next.getUTCHours()}:${String(next.getUTCMinutes()).padStart(2, '0')}`;
  };

  it('names its timezone instead of depending on the server clock', () => {
    expect(repeatFor('daily-brief-8am-ist').tz).toBe('Asia/Kolkata');
    expect(repeatFor('consider-digest-2pm-ist').tz).toBe('Asia/Kolkata');
  });

  it('sends the morning brief at 08:00 IST (02:30 UTC)', () => {
    expect(nextUtcHourMinute(repeatFor('daily-brief-8am-ist'))).toBe('2:30');
  });

  it('sends the CONSIDER digest at 14:00 IST (08:30 UTC)', () => {
    expect(nextUtcHourMinute(repeatFor('consider-digest-2pm-ist'))).toBe('8:30');
  });
});
