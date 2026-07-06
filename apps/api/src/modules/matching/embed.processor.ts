import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EMBED_JOBS_QUEUE } from '../internal/internal.constants';
import { MatchingService } from './matching.service';

/** Embeds newly ingested jobs as they arrive — keeps the corpus current so
 *  incremental matching (Phase C) never waits on a bulk backfill. */
@Processor(EMBED_JOBS_QUEUE)
export class EmbedProcessor extends WorkerHost {
  private readonly logger = new Logger(EmbedProcessor.name);

  constructor(private readonly matching: MatchingService) {
    super();
  }

  async process(job: Job<{ jobIds: string[] }>) {
    const embedded = await this.matching.embedJobsByIds(job.data.jobIds);
    if (embedded > 0) this.logger.log(`Embedded ${embedded} new job(s) at ingest`);
    return { embedded };
  }
}
