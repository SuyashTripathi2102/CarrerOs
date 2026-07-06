import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CompaniesModule } from '../companies/companies.module';
import { IngestService } from './ingest.service';
import { InternalController } from './internal.controller';
import { EMBED_JOBS_QUEUE } from './internal.constants';

@Module({
  imports: [CompaniesModule, BullModule.registerQueue({ name: EMBED_JOBS_QUEUE })],
  controllers: [InternalController],
  providers: [IngestService],
})
export class InternalModule {}
