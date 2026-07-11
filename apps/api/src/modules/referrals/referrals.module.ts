import { Module } from '@nestjs/common';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

/**
 * PrismaModule and AiModule are @Global, so no imports are needed — the service
 * injects PrismaService and LLM_PROVIDER directly.
 */
@Module({
  controllers: [ReferralsController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
