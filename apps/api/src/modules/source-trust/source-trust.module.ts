import { Module } from '@nestjs/common';
import { SourceTrustController, SourceTrustInternalController } from './source-trust.controller';
import { SourceTrustService } from './source-trust.service';

@Module({
  controllers: [SourceTrustController, SourceTrustInternalController],
  providers: [SourceTrustService],
  exports: [SourceTrustService],
})
export class SourceTrustModule {}
