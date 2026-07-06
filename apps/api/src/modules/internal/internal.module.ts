import { Module } from '@nestjs/common';
import { CompaniesModule } from '../companies/companies.module';
import { IngestService } from './ingest.service';
import { InternalController } from './internal.controller';

@Module({
  imports: [CompaniesModule],
  controllers: [InternalController],
  providers: [IngestService],
})
export class InternalModule {}
