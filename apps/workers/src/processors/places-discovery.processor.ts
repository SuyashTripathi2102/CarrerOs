import { Job, Queue, Worker } from 'bullmq';
import { ApiClient } from '../api-client';
import { QueueNames } from '../queues/names';
import { createRedisConnection } from '../queues/connection';
import {
  runPlacesCityDiscovery,
  type PlacesDiscoveryOverride,
} from '../discovery/places-city-discovery';

export function startPlacesDiscoveryWorker(api: ApiClient): Worker {
  return new Worker(
    QueueNames.PLACES_DISCOVERY,
    // Job data may carry a {cities, queries, maxPages} override — used for the
    // one-city smoke test before the full sweep. Empty = the scheduled full run.
    async (job: Job<PlacesDiscoveryOverride | undefined>) =>
      runPlacesCityDiscovery(api, job.data ?? {}),
    { connection: createRedisConnection() },
  );
}

/** Weekly — cities don't grow new software companies daily; quota stays tiny. */
export async function ensurePlacesDiscoverySchedule(): Promise<void> {
  const queue = new Queue(QueueNames.PLACES_DISCOVERY, { connection: createRedisConnection() });
  await queue.upsertJobScheduler(
    'places-city-weekly',
    { pattern: '0 3 * * 1' }, // Mondays 03:00 UTC = 08:30 IST
    {
      name: 'scheduled',
      opts: { attempts: 2, removeOnComplete: true, removeOnFail: true },
    },
  );
  await queue.close();
  console.log('[scheduler] places-city-discovery: weekly (Mon 08:30 IST)');
}
