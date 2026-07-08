import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PrismaService } from '../../prisma/prisma.service';
import { DailyBriefService } from './daily-brief.service';

/**
 * Mission Control data (ROADMAP v0.3): the brief + the north-star funnel.
 * `applied` counts arrive with the tracker — shown as 0 until then, honestly.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly brief: DailyBriefService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async get(@CurrentUser() user: AuthenticatedUser) {
    const [briefData, jobsTotal, matches, ge60, notified, applied] = await Promise.all([
      this.brief.data(user.id),
      this.prisma.job.count({ where: { status: 'ACTIVE' } }),
      this.prisma.jobMatch.count({ where: { userId: user.id } }),
      this.prisma.jobMatch.count({
        where: { userId: user.id, opportunityScore: { gte: 60 } },
      }),
      this.prisma.jobMatch.count({
        where: { userId: user.id, notifiedAt: { not: null } },
      }),
      this.prisma.application.count({ where: { userId: user.id } }),
    ]);

    return {
      brief: briefData,
      funnel: { crawled: jobsTotal, matched: matches, recommended: ge60, notified, applied },
    };
  }
}
