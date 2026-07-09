import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EMBED_JOBS_QUEUE } from '../internal/internal.constants';
import { NotificationsModule } from '../notifications/notifications.module';
import { OpportunityModule } from '../opportunity/opportunity.module';
import { EmbedProcessor } from './embed.processor';
import { MATCH_NEW_JOBS_QUEUE } from './matching.constants';
import { MatchNewJobsProcessor } from './match-new-jobs.processor';
import { MatchingController, MatchingInternalController } from './matching.controller';
import { GENERATE_MATCHES_QUEUE, MatchingProcessor } from './matching.processor';
import { JobClassifierService } from './job-classifier.service';
import { MatchingService } from './matching.service';

@Module({
  imports: [
    OpportunityModule,
    NotificationsModule,
    BullModule.registerQueue({ name: GENERATE_MATCHES_QUEUE }),
    BullModule.registerQueue({ name: EMBED_JOBS_QUEUE }),
    BullModule.registerQueue({ name: MATCH_NEW_JOBS_QUEUE }),
  ],
  controllers: [MatchingController, MatchingInternalController],
  providers: [
    MatchingService,
    JobClassifierService,
    MatchingProcessor,
    EmbedProcessor,
    MatchNewJobsProcessor,
  ],
  exports: [MatchingService],
})
export class MatchingModule {}
