import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { SourceTrustService } from './source-trust.service';

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
@Controller('source-trust')
export class SourceTrustController {
  constructor(private readonly trust: SourceTrustService) {}

  @Get()
  list() {
    return this.trust.list();
  }
}
