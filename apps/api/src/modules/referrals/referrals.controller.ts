import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ReferralsService } from './referrals.service';

/**
 * Referral Engine — public-source people discovery + user-sent outreach drafts.
 * JWT-guarded (the global guard); every route is scoped to the current user.
 */
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  /** Ranked shortlist of who could refer you into this job (cached per company). */
  @Get('job/:jobId')
  forJob(@CurrentUser() user: AuthenticatedUser, @Param('jobId') jobId: string) {
    return this.referrals.forJob(user.id, jobId);
  }

  /** Draft a personalised outreach message for one contact — you review & send it. */
  @Post(':id/draft')
  @HttpCode(HttpStatus.OK)
  draft(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.referrals.generateDraft(user.id, id);
  }

  /** Advance a contact through the outreach pipeline (SUGGESTED → … → REPLIED). */
  @Patch(':id/status')
  status(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: { status: string },
  ) {
    return this.referrals.setStatus(user.id, id, body.status);
  }
}
