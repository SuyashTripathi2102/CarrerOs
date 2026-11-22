import { Queue, Worker } from 'bullmq';
import { ApiClient } from '../api-client';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';

export const BRIEF_TIMEZONE = 'Asia/Kolkata';

/** 8:00 AM IST morning brief + 2:00 PM CONSIDER digest — the workers only pull
 *  the trigger; the API composes and sends (it owns the DB + Telegram). The
 *  job `name` selects which: 'scheduled' = brief, 'consider-digest' = digest. */
export function startDailyBriefWorker(api: ApiClient): Worker {
  return new Worker(
    QueueNames.DAILY_BRIEF,
    async (job) => {
      if (job.name === 'consider-digest') {
        const res = await api.triggerConsiderDigest();
        console.log(`[consider-digest] sent: ${res.sent}`);
        return res;
      }
      // Refresh source-trust before the morning's scoring reflects it — one
      // cheap aggregate; a failure here must never block the brief.
      try {
        const t = await api.recomputeSourceTrust();
        console.log(`[source-trust] recomputed: ${t.sources} sources`);
      } catch (err) {
        console.warn(`[source-trust] recompute skipped: ${String(err)}`);
      }
      // Refresh deterministic company signals (growth/velocity/departments) for
      // the whole corpus — SQL only, cheap, keeps the Opportunity Score current.
      try {
        const s = await api.deriveCompanySignals();
        console.log(`[company-signals] refreshed: ${s.companies} companies`);
      } catch (err) {
        console.warn(`[company-signals] refresh skipped: ${String(err)}`);
      }
      const res = await api.triggerDailyBrief();
      console.log(
        `[daily-brief] sent: ${res.sent}${res.skipped ? `, skipped ${res.skipped} (already sent today)` : ''}`,
      );
      return res;
    },
    { connection: createRedisConnection() },
  );
}

export async function ensureDailyBriefSchedule(): Promise<void> {
  const queue = new Queue(QueueNames.DAILY_BRIEF, {
    connection: createRedisConnection(),
  });
  // 6 attempts, 1-2-4-8-16 min apart: about 31 min of retries. After a laptop wakes, the network can
  // flap for that long (22 Nov 2026: DNS failures from 22:09 to about 22:40 IST). The API refuses only
  // failures that certainly did not deliver, and skips users already served today, so a retry never
  // sends a brief twice.
  const opts = {
    attempts: 6,
    backoff: { type: 'exponential' as const, delay: 60_000 },
    removeOnComplete: true,
    removeOnFail: true,
  };
  // Without tz, BullMQ reads a pattern in the server's local time, so the same
  // pattern fires at different hours on a laptop and on a UTC server.
  await queue.upsertJobScheduler(
    'daily-brief-8am-ist',
    { pattern: '0 8 * * *', tz: BRIEF_TIMEZONE },
    { name: 'scheduled', opts },
  );
  await queue.upsertJobScheduler(
    'consider-digest-2pm-ist',
    { pattern: '0 14 * * *', tz: BRIEF_TIMEZONE },
    { name: 'consider-digest', opts },
  );
  await queue.close();
  console.log('[scheduler] daily-brief: 08:00 IST; consider-digest: 14:00 IST');
}
