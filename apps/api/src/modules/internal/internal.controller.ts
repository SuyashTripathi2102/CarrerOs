import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { BoardJobSchema, NormalizedJobSchema } from '@careeros/shared';
import { Public } from '../../common/decorators/public.decorator';
import { CompaniesService } from '../companies/companies.service';
import { IngestService } from './ingest.service';
import { CompanyIdentityService } from './company-identity.service';
import { AtsConflictService } from './ats-conflict.service';
import { InternalTokenGuard } from './internal-token.guard';

const SyncBodySchema = z.object({
  source: z.string().min(1),
  jobs: z.array(NormalizedJobSchema),
  /**
   * Did the crawl see the WHOLE board? Defaults true so every existing caller
   * keeps its current behaviour; only an adapter that knows it walked off the
   * end sends false. A partial board must never drive retirement.
   */
  boardComplete: z.boolean().optional().default(true),
});

/**
 * Repair descriptions on jobs that ALREADY exist. Update-only by construction.
 *
 * A normal re-crawl cannot be used for this: syncCompanyJobs reconciles, so any
 * board that returned fewer rows than the corpus holds would retire the
 * difference. Repairing 6,907 empty descriptions must not be able to delete a
 * single job — the Workday truncation incident is exactly this shape.
 */
const RepairBodySchema = z.object({
  source: z.string().min(1),
  updates: z
    .array(
      z.object({
        externalId: z.string().min(1),
        description: z.string(),
        descriptionSource: z.enum(['LIST', 'DETAIL', 'MISSING']),
      }),
    )
    .max(2000),
});

const BoardBodySchema = z.object({
  /** Where the JOB came from — the ATS or board actually crawled (acquiredFrom). */
  source: z.string().min(1),
  /**
   * What introduced the COMPANY (discoveredBy), when that differs from the
   * board the job was fetched from. A company found through an India company
   * directory whose jobs are then crawled from Greenhouse is discoveredBy that
   * directory and acquiredFrom greenhouse — collapsing the two is what made
   * FreeHire read as 67.1% of actionable when the real figure was 92.7%.
   * Defaults to `source`, which is correct whenever a board is both.
   */
  discoverySource: z.string().min(1).optional(),
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
    private readonly identity: CompanyIdentityService,
    private readonly ats: AtsConflictService,
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
    return this.ingest.syncCompanyJobs(
      companyId,
      parsed.data.source,
      parsed.data.jobs,
      parsed.data.boardComplete,
    );
  }

  /**
   * ACTIVE jobs with a body too thin to judge and their own absolute URL — the
   * evidence exists and was never fetched. Read-only; the caller decides what,
   * if anything, is worth writing back through repair-descriptions.
   */
  @Get('jobs/hydration-due')
  hydrationDue(@Query('limit') limit?: string) {
    const n = Number(limit ?? 50);
    return this.ingest.hydrationDue(Number.isFinite(n) ? n : 50);
  }

  /**
   * Update description + provenance on existing rows. Never inserts, never
   * retires, never touches any other column.
   */
  @Post('jobs/repair-descriptions')
  repairDescriptions(@Body() body: unknown) {
    const parsed = RepairBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.ingest.repairDescriptions(parsed.data.source, parsed.data.updates);
  }

  /**
   * Re-enqueue ACTIVE jobs that lost their embed enqueue. Idempotent and
   * bounded; see IngestService.reconcileEmbeddings for why a grace period is
   * what separates "stranded" from "in flight".
   */
  @Post('embeddings/reconcile')
  reconcileEmbeddings() {
    return this.ingest.reconcileEmbeddings();
  }

  @Post('boards/ingest')
  ingestBoard(@Body() body: unknown) {
    const parsed = BoardBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.ingest.ingestBoardJobs(
      parsed.data.source,
      parsed.data.entries,
      parsed.data.discoverySource,
    );
  }

  // ── ADR-11 company identity ──────────────────────────────────────────────

  /** Derive identity tokens from apply URLs. Idempotent, no merging. */
  @Post('company-identity/backfill-tokens')
  backfillTokens() {
    return this.identity.backfillIdentityTokens().then((companies) => ({ companies }));
  }

  /**
   * Resolve aliases. DRY RUN BY DEFAULT — `?apply=true` is required to write,
   * and even then only STRONG evidence merges.
   */
  @Post('company-identity/resolve')
  resolveIdentity(@Query('apply') apply?: string) {
    return this.identity.resolve(apply !== 'true');
  }

  /** Alias candidates awaiting a human decision. Read-only. */
  @Get('company-identity/review')
  identityReview() {
    return this.identity.pendingReview();
  }

  /**
   * Companies whose stored ATS is contradicted by their own apply URLs.
   * DRY RUN BY DEFAULT — `?apply=true` writes the correction.
   */
  @Post('ats-conflicts/resolve')
  resolveAtsConflicts(@Query('apply') apply?: string) {
    return this.ats.resolve(apply !== 'true');
  }
}
