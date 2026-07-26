import { BadRequestException, Body, Controller, DefaultValuePipe, Get, ParseIntPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AnalyticsService } from './analytics.service';

const EventSchema = z.object({
  jobId: z.string().min(1),
  type: z.enum(['VIEWED', 'CLICKED', 'DISMISSED', 'APPLIED']),
  surface: z.enum(['browse', 'today', 'telegram', 'tracker']).optional(),
});

@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /** Record a user action on a recommendation (append-only outcome log). */
  @Post('events')
  record(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = EventSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.analytics.record(user.id, parsed.data.jobId, parsed.data.type, parsed.data.surface);
  }

  /** Which signals separate engagement from dismissal — the Validation metric. */
  @Get('analytics/signals')
  signals(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days', new DefaultValuePipe(90), ParseIntPipe) days: number,
  ) {
    return this.analytics.signalOutcomes(user.id, Math.min(365, Math.max(1, days)));
  }
}
