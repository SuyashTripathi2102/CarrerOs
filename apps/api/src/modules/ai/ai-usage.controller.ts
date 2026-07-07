import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiUsageService } from './ai-usage.service';

/**
 * The AI dashboard endpoint (JWT-guarded by the global guard). Reports the
 * active provider config plus usage/cost/latency/error aggregates. Credits
 * remaining is NOT here — Google doesn't expose trial-credit balance via a
 * simple API; check Cloud Console → Billing → Credits.
 */
@Controller('ai')
export class AiUsageController {
  constructor(
    private readonly usage: AiUsageService,
    private readonly config: ConfigService,
  ) {}

  @Get('usage')
  async getUsage() {
    // `||` (not config defaults) so empty strings from compose fall through
    const fallback = this.config.get<string>('AI_PROVIDER') || 'gemini';
    const llmProvider = this.config.get<string>('LLM_PROVIDER') || fallback;
    const embProvider = this.config.get<string>('EMBEDDING_PROVIDER') || fallback;
    const geminiText = this.config.get<string>('GEMINI_TEXT_MODEL', 'gemini-3.5-flash');
    const geminiEmbed = this.config.get<string>('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-2');
    const providers = {
      llm: {
        provider: llmProvider,
        model:
          llmProvider === 'vertex'
            ? this.config.get<string>('VERTEX_TEXT_MODEL', geminiText)
            : geminiText,
      },
      embedding: {
        provider: embProvider,
        model:
          embProvider === 'vertex'
            ? this.config.get<string>('VERTEX_EMBEDDING_MODEL', geminiEmbed)
            : geminiEmbed,
      },
    };
    return { providers, ...(await this.usage.stats()) };
  }
}
