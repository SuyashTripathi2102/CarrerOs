import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { BoardJobSchema, NormalizedJobSchema } from '@careeros/shared';
import { Public } from '../../common/decorators/public.decorator';
import { CompaniesService } from '../companies/companies.service';
import { IngestService } from './ingest.service';
import { InternalTokenGuard } from './internal-token.guard';

const SyncBodySchema = z.object({
  source: z.string().min(1),
  jobs: z.array(NormalizedJobSchema),
});

const BoardBodySchema = z.object({
  source: z.string().min(1),
  entries: z.array(BoardJobSchema),
});

/**
 * Service-to-service API for workers/scraper. @Public() skips user-JWT auth;
 * InternalTokenGuard enforces the shared secret instead. Validation is Zod
 * (shared contract) rather than class-validator — same schemas the workers
 * compile against.
 */
@Public()
@UseGuards(InternalTokenGuard)
@Controller('internal')
export class InternalController {
  constructor(
    private readonly ingest: IngestService,
    private readonly companies: CompaniesService,
  ) {}

  @Get('companies/due')
  companiesDue() {
    return this.companies.findCrawlable();
  }

  @Post('companies/:id/jobs/sync')
  async syncJobs(@Param('id') companyId: string, @Body() body: unknown) {
    const parsed = SyncBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.companies.get(companyId); // 404 if unknown
    return this.ingest.syncCompanyJobs(companyId, parsed.data.source, parsed.data.jobs);
  }

  @Post('boards/ingest')
  ingestBoard(@Body() body: unknown) {
    const parsed = BoardBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.ingest.ingestBoardJobs(parsed.data.source, parsed.data.entries);
  }
}
