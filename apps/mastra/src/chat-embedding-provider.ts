import {
  createGeminiEmbeddingProvider,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
} from '@pufu-lens/ingestion/embedding';
import type { ChatEmbeddingProvider } from '@pufu-lens/web/chat';

/**
 * Creates the Gemini query embedding provider used by private-chat retrieval.
 *
 * Mastra builds without runtime secrets receive a provider that fails only when invoked, while
 * deployed chat requests require `GEMINI_API_KEY`. Model and dimensions are validated eagerly so
 * query vectors cannot be compared with a different document chunk vector schema.
 *
 * @param env - Runtime environment containing Gemini embedding configuration
 * @returns A configured query embedding provider or a build-safe unavailable provider
 */
export function createChatEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
): ChatEmbeddingProvider {
  const dimensions = Number(env.GEMINI_EMBEDDING_DIMENSIONS ?? DEFAULT_EMBEDDING_DIMENSIONS);
  const model = env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_GEMINI_EMBEDDING_MODEL;
  if (dimensions !== DEFAULT_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `GEMINI_EMBEDDING_DIMENSIONS must be ${DEFAULT_EMBEDDING_DIMENSIONS}; got ${String(dimensions)}.`,
    );
  }
  if (model.trim().length === 0) {
    throw new Error('GEMINI_EMBEDDING_MODEL is required for private chat embedding.');
  }
  if (!env.GEMINI_API_KEY) {
    return {
      dimensions,
      model,
      async embedTexts() {
        throw new Error('GEMINI_API_KEY is required for private chat embedding.');
      },
    };
  }
  return createGeminiEmbeddingProvider({
    apiKey: env.GEMINI_API_KEY,
    dimensions,
    model,
  });
}
