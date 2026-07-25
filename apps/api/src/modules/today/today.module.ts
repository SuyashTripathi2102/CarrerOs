import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';
import { TodayController } from './today.controller';
import { TodayService } from './today.service';

/** MatchingModule exports MatchingService (the shared Opportunity Score feed). */
@Module({
  imports: [MatchingModule],
  controllers: [TodayController],
  providers: [TodayService],
})
export class TodayModule {}
