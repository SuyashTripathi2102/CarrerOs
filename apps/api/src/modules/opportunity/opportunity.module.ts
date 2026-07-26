import { Module } from '@nestjs/common';
import { SourceTrustModule } from '../source-trust/source-trust.module';
import { OpportunityService } from './opportunity.service';

@Module({
  imports: [SourceTrustModule],
  providers: [OpportunityService],
  exports: [OpportunityService],
})
export class OpportunityModule {}
