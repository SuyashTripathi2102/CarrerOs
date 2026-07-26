import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CompanyCandidateSchema, DiscoveryResultSchema } from '@careeros/shared';
import { Public } from '../../common/decorators/public.decorator';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { DiscoveryService } from './discovery.service';

const BulkBodySchema = z.object({
  source: z.string().min(1),
  candidates: z.array(CompanyCandidateSchema).max(5000),
});

const SnapshotBodySchema = z.object({
  companyId: z.string().min(1),
  url: z.string().url(),
  html: z.string().max(2_000_000),
  extractorVersion: z.string().min(1),
  confidence: z.number().int().min(0).max(100).default(0),
  jobsAccepted: z.number().int().min(0).default(0),
  candidateCount: z.number().int().min(0).default(0),
});

/** Internal (worker-facing) endpoints of the Company Discovery Engine. */
@Public()
@UseGuards(InternalTokenGuard)
@Controller('internal/discovery')
export class DiscoveryInternalController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Post('bulk')
  bulk(@Body() body: unknown) {
    const parsed = BulkBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.discovery.bulkDiscover(parsed.data.source, parsed.data.candidates);
  }

  @Get('due')
  due(@Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number) {
    return this.discovery.probeDue(Math.min(limit, 100));
  }

  /** Career pages (career URL known, ATS unknown) for the deterministic extractor. */
  @Get('career-pages/due')
  careerPagesDue(@Query('limit', new DefaultValuePipe(30), ParseIntPipe) limit: number) {
    return this.discovery.careerPagesDue(limit);
  }

  /** Persist the preprocessed HTML of a career page — replay's raw material. */
  @Post('snapshot')
  snapshot(@Body() body: unknown) {
    const parsed = SnapshotBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.discovery.storeSnapshot(parsed.data);
  }

  /** Stored snapshots a newer extractor version hasn't reprocessed yet. */
  @Get('snapshots/replay-due')
  replayDue(
    @Query('version') version: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    if (!version) throw new BadRequestException('version is required');
    return this.discovery.snapshotsReplayDue(version, limit);
  }

  @Post(':companyId/result')
  result(@Param('companyId') companyId: string, @Body() body: unknown) {
    const parsed = DiscoveryResultSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.discovery.applyResult(companyId, parsed.data);
  }
}

/** User-facing: the conversion funnel — Phase B's success metric. */
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get('stats')
  stats() {
    return this.discovery.funnelStats();
  }

  /** Per-city discovery coverage — where we're strong and where we're blind. */
  @Get('coverage')
  coverage() {
    return this.discovery.cityCoverage();
  }

  /** Deterministic career-page extractor — operational health. */
  @Get('extraction')
  extraction() {
    return this.discovery.extractionHealth();
  }

  /** Replay backlog: captured snapshots + how many are behind the current parser. */
  @Get('replay')
  replay(@Query('version') version?: string) {
    return this.discovery.replayStatus(version || 'deterministic-v1');
  }
}
