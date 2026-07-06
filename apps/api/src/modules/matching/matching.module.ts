import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EMBED_JOBS_QUEUE } from '../internal/internal.constants';
import { EmbedProcessor } from './embed.processor';
import { MatchingController } from './matching.controller';
import { GENERATE_MATCHES_QUEUE, MatchingProcessor } from './matching.processor';
import { MatchingService } from './matching.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: GENERATE_MATCHES_QUEUE }),
    BullModule.registerQueue({ name: EMBED_JOBS_QUEUE }),
  ],
  controllers: [MatchingController],
  providers: [MatchingService, MatchingProcessor, EmbedProcessor],
})
export class MatchingModule {}
