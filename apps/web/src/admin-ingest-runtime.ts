import {
  EMBEDDING_PROVIDER_NAMES,
  type EmbeddingProviderName,
  resolveEmbeddingRuntimeConfig,
} from '@pufu-lens/ingestion/embedding-runtime';

export const ADMIN_INGEST_EMBEDDING_PROVIDERS = EMBEDDING_PROVIDER_NAMES;
export type AdminIngestEmbeddingProvider = EmbeddingProviderName;

export const DEFAULT_ADMIN_INGEST_EMBEDDING_PROVIDER: AdminIngestEmbeddingProvider = 'gemini';

type AdminIngestEmbeddingEnv = Readonly<Record<string, string | undefined>>;

/**
 * Resolves the embedding provider used by Admin Data Source ingestion.
 *
 * Production and Admin UI ingestion use the shared runtime provider so stored document vectors
 * share the query embedding space used by Chat. Deterministic embeddings remain available only
 * through an explicit setting for local and test workflows.
 *
 * @param env - Full runtime environment, including `NODE_ENV` and `PUFU_LENS_EMBEDDING_PROVIDER`
 * @returns A validated provider accepted by the ingestion workflow
 * @throws When a configured value is empty or unsupported
 * @throws When `deterministic` is selected while `NODE_ENV` is exactly `production`
 */
export function resolveAdminIngestEmbeddingProvider(
  env: AdminIngestEmbeddingEnv = process.env,
): AdminIngestEmbeddingProvider {
  return resolveEmbeddingRuntimeConfig({
    defaultProvider: DEFAULT_ADMIN_INGEST_EMBEDDING_PROVIDER,
    env,
  }).provider;
}
