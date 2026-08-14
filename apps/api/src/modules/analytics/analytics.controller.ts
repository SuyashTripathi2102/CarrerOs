import { BadRequestException, Body, Controller, DefaultValuePipe, Get, ParseIntPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AnalyticsService } from './analytics.service';

const SURFACES = ['browse', 'today', 'telegram', 'tracker'] as const;

/**
 * What the surface actually rendered. Optional: server-side emitters (the
 * application tracker) legitimately have nothing on screen to report, and that
 * is recorded as NULL rather than guessed at.
 */
const DisplayedSchema = {
  displayedScore: z.number().min(0).max(100).optional(),
  displayedVerdict: z.string().min(1).max(32).optional(),
};

const EventSchema = z.object({
  jobId: z.string().min(1),
  type: z.enum(['SHOWN', 'CLICKED', 'DISMISSED', 'APPLIED']),
  surface: z.enum(SURFACES).optional(),
  rank: z.number().int().min(0).optional(),
  ...DisplayedSchema,
});

const ImpressionsSchema = z.object({
  surface: z.enum(SURFACES),
  items: z
    .array(
      z.object({
        jobId: z.string().min(1),
        rank: z.number().int().min(0).optional(),
        ...DisplayedSchema,
      }),
    )
    .max(200),
});

@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Record a user action on a recommendation (append-only outcome log). */
  @Post('events')
  record(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = EventSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const { jobId, type, surface, rank, displayedScore, displayedVerdict } = parsed.data;
    return this.analytics.record(user.id, jobId, type, surface, rank, {
      displayedScore,
      displayedVerdict,
    });
  }

  /** Batch-record SHOWN impressions for a rendered list — the CTR denominator. */
  @Post('events/impressions')
  impressions(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = ImpressionsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.analytics.recordImpressions(user.id, parsed.data.surface, parsed.data.items);
  }

  /** Which signals separate engagement from dismissal — the Validation metric. */
  @Get('analytics/signals')
  signals(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days', new DefaultValuePipe(90), ParseIntPipe) days: number,
  ) {
    return this.analytics.signalOutcomes(user.id, Math.min(365, Math.max(1, days)));
  }

  /** Recommendation Quality: CTR / apply / dismiss funnel + score separation + lift. */
  @Get('analytics/quality')
  quality(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days', new DefaultValuePipe(90), ParseIntPipe) days: number,
  ) {
    return this.analytics.quality(user.id, Math.min(365, Math.max(1, days)));
  }
}
