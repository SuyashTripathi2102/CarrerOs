import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiUsageController } from './ai-usage.controller';
import { AiUsageService } from './ai-usage.service';
import { GeminiProvider } from './gemini.provider';
import { EMBEDDING_PROVIDER, LLM_PROVIDER } from './llm.provider';

/**
 * Global so any feature module can inject LLM_PROVIDER / EMBEDDING_PROVIDER.
 * Each token is selected independently (LLM_PROVIDER / EMBEDDING_PROVIDER env,
 * both falling back to AI_PROVIDER) — embeddings and generation have separate
 * vendor markets, so they must be swappable separately. Add OpenAI/Claude/etc.
 * implementations here without touching any feature code.
 */
@Global()
@Module({
  controllers: [AiUsageController],
  providers: [
    AiUsageService,
    GeminiProvider,
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService, GeminiProvider],
      useFactory: (config: ConfigService, gemini: GeminiProvider) => {
        const provider = config.get<string>(
          'LLM_PROVIDER',
          config.get<string>('AI_PROVIDER', 'gemini'),
        );
        switch (provider) {
          case 'gemini':
            return gemini;
          default:
            throw new Error(`Unknown LLM_PROVIDER "${provider}" (supported: gemini)`);
        }
      },
    },
    {
      provide: EMBEDDING_PROVIDER,
      inject: [ConfigService, GeminiProvider],
      useFactory: (config: ConfigService, gemini: GeminiProvider) => {
        const provider = config.get<string>(
          'EMBEDDING_PROVIDER',
          config.get<string>('AI_PROVIDER', 'gemini'),
        );
        switch (provider) {
          case 'gemini':
            return gemini;
          default:
            throw new Error(`Unknown EMBEDDING_PROVIDER "${provider}" (supported: gemini)`);
        }
      },
    },
  ],
  exports: [LLM_PROVIDER, EMBEDDING_PROVIDER, AiUsageService],
})
export class AiModule {}
