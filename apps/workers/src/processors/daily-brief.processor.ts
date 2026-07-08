import { Queue, Worker } from 'bullmq';
import { ApiClient } from '../api-client';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';

/** 8:00 AM IST morning brief — the workers only pull the trigger; the API
 *  composes and sends (it owns the DB and the Telegram channel). */
export function startDailyBriefWorker(api: ApiClient): Worker {
  return new Worker(
    QueueNames.DAILY_BRIEF,
    async () => {
      const res = await api.triggerDailyBrief();
      console.log(`[daily-brief] sent: ${res.sent}`);
      return res;
    },
    { connection: createRedisConnection() },
  );
}

export async function ensureDailyBriefSchedule(): Promise<void> {
  const queue = new Queue(QueueNames.DAILY_BRIEF, { connection: createRedisConnection() });
  await queue.upsertJobScheduler(
    'daily-brief-8am-ist',
    { pattern: '30 2 * * *' }, // 02:30 UTC = 08:00 IST
    {
      name: 'scheduled',
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    },
  );
  await queue.close();
  console.log('[scheduler] daily-brief: 08:00 IST');
}
