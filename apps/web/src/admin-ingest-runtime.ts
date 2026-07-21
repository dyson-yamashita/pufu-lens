export const ADMIN_INGEST_EMBEDDING_PROVIDERS = ['deterministic', 'gemini'] as const;

export type AdminIngestEmbeddingProvider = (typeof ADMIN_INGEST_EMBEDDING_PROVIDERS)[number];

export const DEFAULT_ADMIN_INGEST_EMBEDDING_PROVIDER: AdminIngestEmbeddingProvider = 'gemini';

/**
 * Resolves the embedding provider used by Admin Data Source ingestion.
 *
 * Production and Admin UI ingestion default to Gemini so stored document vectors share the
 * query embedding space used by Chat. Deterministic embeddings remain available only through an
 * explicit setting for local and test workflows.
 *
 * @param configuredProvider - Optional runtime value from
 *   `PUFU_LENS_ADMIN_INGEST_EMBEDDING_PROVIDER`
 * @returns A validated provider accepted by the ingestion workflow
 * @throws When a configured value is empty or unsupported
 */
export function resolveAdminIngestEmbeddingProvider(
  configuredProvider: string | undefined,
): AdminIngestEmbeddingProvider {
  if (configuredProvider === undefined) {
    return DEFAULT_ADMIN_INGEST_EMBEDDING_PROVIDER;
  }
  if (configuredProvider === 'deterministic' || configuredProvider === 'gemini') {
    return configuredProvider;
  }
  throw new Error(
    `PUFU_LENS_ADMIN_INGEST_EMBEDDING_PROVIDER must be one of: ${ADMIN_INGEST_EMBEDDING_PROVIDERS.join(', ')}`,
  );
}
