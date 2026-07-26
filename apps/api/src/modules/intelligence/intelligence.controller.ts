import {
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Public } from '../../common/decorators/public.decorator';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { DERIVE_INTEL_QUEUE } from './intelligence.processor';
import { IntelligenceService } from './intelligence.service';

@Controller()
export class IntelligenceController {
  constructor(
    private readonly intel: IntelligenceService,
    @InjectQueue(DERIVE_INTEL_QUEUE) private readonly queue: Queue,
  ) {}

  @Get('companies/:id/intelligence')
  get(@Param('id') id: string) {
    return this.intel.get(id);
  }

  /** Companies with the most hiring momentum right now — dashboard mover list. */
  @Get('intelligence/top-growing')
  topGrowing(@Query('limit', new DefaultValuePipe(12), ParseIntPipe) limit: number) {
    return this.intel.topGrowing(limit);
  }

  /** Kick off LLM derivation for companies with stale/missing profiles. */
  @Post('intelligence/derive')
  @HttpCode(HttpStatus.ACCEPTED)
  async derive() {
    const job = await this.queue.add(
      'derive',
      {},
      { removeOnComplete: true, removeOnFail: true },
    );
    return { enqueued: true, jobId: job.id };
  }
}

/** Internal (worker-facing): the daily deterministic corpus-wide signal pass. */
@Public()
@UseGuards(InternalTokenGuard)
@Controller('internal/intelligence')
export class IntelligenceInternalController {
  constructor(private readonly intel: IntelligenceService) {}

  @Post('derive-signals')
  deriveSignals() {
    return this.intel.deriveSignalsCorpus();
  }
}
