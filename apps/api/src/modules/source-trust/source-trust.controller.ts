import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { SourceTrustService } from './source-trust.service';
import { Role } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';

/** Internal (worker-facing): daily recompute trigger. */
@Public()
@UseGuards(InternalTokenGuard)
@Controller('internal/source-trust')
export class SourceTrustInternalController {
  constructor(private readonly trust: SourceTrustService) {}

  @Post('recompute')
  recompute() {
    return this.trust.recompute();
  }
}

/** User-facing: the trust table behind Discovery Health's source yield. */
// Operator only (W8): the account's current role is checked against the database by RolesGuard.
@Roles(Role.ADMIN)
@Controller('source-trust')
export class SourceTrustController {
  constructor(private readonly trust: SourceTrustService) {}

  @Get()
  list() {
    return this.trust.list();
  }
}
