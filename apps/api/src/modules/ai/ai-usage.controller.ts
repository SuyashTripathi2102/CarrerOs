import { Controller, Get } from '@nestjs/common';
import { AiUsageService } from './ai-usage.service';

/** JWT-guarded by the global guard — usage numbers are account-sensitive. */
@Controller('ai')
export class AiUsageController {
  constructor(private readonly usage: AiUsageService) {}

  @Get('usage')
  getUsage() {
    return this.usage.stats();
  }
}
