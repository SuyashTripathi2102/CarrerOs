import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiUsageController } from './ai-usage.controller';
import { AiUsageService } from './ai-usage.service';
import { GeminiProvider } from './gemini.provider';
import { VertexGeminiProvider } from './vertex-gemini.provider';
import { EMBEDDING_PROVIDER, LLM_PROVIDER } from './llm.provider';

/**
 * Global so any feature module can inject LLM_PROVIDER / EMBEDDING_PROVIDER.
 * Each token is selected independently (LLM_PROVIDER / EMBEDDING_PROVIDER env,
 * both falling back to AI_PROVIDER) — embeddings and generation have separate
 * vendor markets, so they must be swappable separately.
 *
 * Providers: "gemini" = Gemini Developer API (API key, prepaid billing);
 * "vertex" = same models via Vertex AI (service account, Google Cloud billing
 * — trial credits apply). Add OpenAI/Claude/etc. here without touching any
 * feature code.
 */
@Global()
@Module({
  controllers: [AiUsageController],
  providers: [
    AiUsageService,
    GeminiProvider,
    VertexGeminiProvider,
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService, GeminiProvider, VertexGeminiProvider],
      useFactory: (config: ConfigService, gemini: GeminiProvider, vertex: VertexGeminiProvider) =>
        pick('LLM_PROVIDER', config, { gemini, vertex }),
    },
    {
      provide: EMBEDDING_PROVIDER,
      inject: [ConfigService, GeminiProvider, VertexGeminiProvider],
      useFactory: (config: ConfigService, gemini: GeminiProvider, vertex: VertexGeminiProvider) =>
        pick('EMBEDDING_PROVIDER', config, { gemini, vertex }),
    },
  ],
  exports: [LLM_PROVIDER, EMBEDDING_PROVIDER, AiUsageService],
})
export class AiModule {}

function pick<T>(envKey: string, config: ConfigService, impls: Record<string, T>): T {
  // `||` (not a config default) so empty strings from compose fall through
  const name = config.get<string>(envKey) || config.get<string>('AI_PROVIDER') || 'gemini';
  const impl = impls[name];
  if (!impl) {
    throw new Error(
      `Unknown ${envKey} "${name}" (supported: ${Object.keys(impls).join(', ')})`,
    );
  }
  return impl;
}
