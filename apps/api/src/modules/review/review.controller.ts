import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { ReviewService } from './review.service';

@Controller()
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  /** Jobs CareerOS could not decide. Visible, never auto-applied. */
  @Get('needs-review')
  needsReview(@CurrentUser() user: AuthenticatedUser) {
    return this.review.needsReview(user.id);
  }

  /** Human judgement, stored apart from the objective classification. */
  @Post('needs-review/:jobId')
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('jobId') jobId: string,
    @Body() body: { relevant: boolean; note?: string },
  ) {
    return this.review.review(user.id, jobId, body.relevant, body.note);
  }

  /** Every rejection, with its exact reason. Audit only. */
  @Get('excluded')
  excluded(@CurrentUser() user: AuthenticatedUser) {
    return this.review.excluded(user.id);
  }
}
