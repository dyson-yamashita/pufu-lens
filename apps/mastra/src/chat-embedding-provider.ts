import type { EmbeddingProvider } from '@pufu-lens/ingestion/embedding';
import { createEmbeddingProviderFromEnv } from '@pufu-lens/ingestion/embedding-runtime';

/**
 * Creates the provider-selected query embedding adapter used by private-chat retrieval.
 *
 * Mastra builds without runtime secrets receive a provider that fails only when invoked, while
 * deployed chat requests require the selected provider credential. Model and dimensions are
 * validated eagerly so query vectors cannot be compared with a different document chunk schema.
 *
 * @param env - Runtime environment containing the shared embedding configuration
 * @returns A configured query embedding provider or a build-safe unavailable provider
 */
export function createChatEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider {
  return createEmbeddingProviderFromEnv({
    allowMissingApiKey: true,
    defaultProvider: 'gemini',
    env,
  });
}
