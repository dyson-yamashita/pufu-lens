import {
  createDeterministicEmbeddingProvider,
  createGeminiEmbeddingProvider,
  createOpenAIEmbeddingProvider,
  DEFAULT_DETERMINISTIC_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  type EmbeddingProvider,
} from './chunk-embedding.js';

export const EMBEDDING_PROVIDER_NAMES = ['deterministic', 'gemini', 'openai'] as const;
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDER_NAMES)[number];

export interface EmbeddingRuntimeConfig {
  readonly apiKey?: string;
  readonly dimensions: number;
  readonly model: string;
  readonly provider: EmbeddingProviderName;
}

type EmbeddingRuntimeEnv = Readonly<Record<string, string | undefined>>;

/**
 * Resolves one shared embedding space for document ingestion and chat query retrieval.
 *
 * Generic `PUFU_LENS_EMBEDDING_*` settings take precedence. Legacy Gemini-specific settings are
 * accepted for compatibility, while provider-specific OpenAI settings support gradual migration.
 * The resolved dimensions must match the current `vector(1536)` database schema.
 *
 * @param input - Environment values plus optional CLI/workflow provider override and default
 * @returns Validated provider, model, dimensions, and provider credential
 * @throws When the provider, model, or dimensions are unsupported or empty
 */
export function resolveEmbeddingRuntimeConfig(input: {
  readonly defaultProvider?: EmbeddingProviderName;
  readonly env: EmbeddingRuntimeEnv;
  readonly provider?: string;
}): EmbeddingRuntimeConfig {
  const configuredProvider = input.env.PUFU_LENS_EMBEDDING_PROVIDER;
  if (
    input.provider !== undefined &&
    configuredProvider !== undefined &&
    input.provider.trim() !== configuredProvider.trim()
  ) {
    throw new Error(
      `Embedding provider mismatch: workflow=${input.provider.trim()}, runtime=${configuredProvider.trim()}.`,
    );
  }
  const provider = parseEmbeddingProvider(
    input.provider ?? configuredProvider ?? input.defaultProvider ?? 'gemini',
  );
  const dimensions = parseEmbeddingDimensions(
    input.env.PUFU_LENS_EMBEDDING_DIMENSIONS ??
      providerDimensionsAlias(input.env, provider) ??
      String(DEFAULT_EMBEDDING_DIMENSIONS),
  );
  const model = resolveEmbeddingModel(input.env, provider);
  const apiKey = input.env.PUFU_LENS_EMBEDDING_API_KEY ?? providerApiKey(input.env, provider);

  return { apiKey, dimensions, model, provider };
}

/**
 * Creates the configured embedding adapter shared by ingestion and private-chat query retrieval.
 *
 * @param input - Runtime environment, optional provider override, and build-safe credential policy
 * @returns A deterministic, Gemini, or OpenAI embedding provider with one shared model identity
 * @throws When configuration is invalid or a required API key is absent outside build-safe mode
 */
export function createEmbeddingProviderFromEnv(input: {
  readonly allowMissingApiKey?: boolean;
  readonly defaultProvider?: EmbeddingProviderName;
  readonly env: EmbeddingRuntimeEnv;
  readonly provider?: string;
}): EmbeddingProvider {
  const config = resolveEmbeddingRuntimeConfig(input);
  if (config.provider === 'deterministic') {
    return createDeterministicEmbeddingProvider({
      dimensions: config.dimensions,
      model: config.model,
    });
  }
  if (!config.apiKey) {
    if (input.allowMissingApiKey) {
      return unavailableEmbeddingProvider(config, config.provider);
    }
    throw missingApiKeyError(config.provider);
  }
  if (config.provider === 'gemini') {
    return createGeminiEmbeddingProvider({
      apiKey: config.apiKey,
      dimensions: config.dimensions,
      model: config.model,
    });
  }
  return createOpenAIEmbeddingProvider({
    apiKey: config.apiKey,
    dimensions: config.dimensions,
    model: config.model,
  });
}

function parseEmbeddingProvider(value: string): EmbeddingProviderName {
  const normalized = value.trim();
  if (normalized === 'deterministic' || normalized === 'gemini' || normalized === 'openai') {
    return normalized;
  }
  throw new Error(
    `PUFU_LENS_EMBEDDING_PROVIDER must be one of: ${EMBEDDING_PROVIDER_NAMES.join(', ')}`,
  );
}

function parseEmbeddingDimensions(value: string): number {
  const dimensions = Number(value);
  if (dimensions !== DEFAULT_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `PUFU_LENS_EMBEDDING_DIMENSIONS must be ${DEFAULT_EMBEDDING_DIMENSIONS}; got ${value}.`,
    );
  }
  return dimensions;
}

function resolveEmbeddingModel(env: EmbeddingRuntimeEnv, provider: EmbeddingProviderName): string {
  const configured =
    env.PUFU_LENS_EMBEDDING_MODEL ?? providerModelAlias(env, provider) ?? defaultModel(provider);
  const model = configured.trim();
  if (!model) {
    throw new Error('PUFU_LENS_EMBEDDING_MODEL must not be empty.');
  }
  return model;
}

function defaultModel(provider: EmbeddingProviderName): string {
  if (provider === 'gemini') {
    return DEFAULT_GEMINI_EMBEDDING_MODEL;
  }
  if (provider === 'openai') {
    return DEFAULT_OPENAI_EMBEDDING_MODEL;
  }
  return DEFAULT_DETERMINISTIC_EMBEDDING_MODEL;
}

function providerModelAlias(
  env: EmbeddingRuntimeEnv,
  provider: EmbeddingProviderName,
): string | undefined {
  if (provider === 'gemini') {
    return env.GEMINI_EMBEDDING_MODEL;
  }
  if (provider === 'openai') {
    return env.OPENAI_EMBEDDING_MODEL;
  }
  return undefined;
}

function providerDimensionsAlias(
  env: EmbeddingRuntimeEnv,
  provider: EmbeddingProviderName,
): string | undefined {
  if (provider === 'gemini') {
    return env.GEMINI_EMBEDDING_DIMENSIONS;
  }
  if (provider === 'openai') {
    return env.OPENAI_EMBEDDING_DIMENSIONS;
  }
  return undefined;
}

function providerApiKey(
  env: EmbeddingRuntimeEnv,
  provider: EmbeddingProviderName,
): string | undefined {
  if (provider === 'gemini') {
    return env.GEMINI_API_KEY;
  }
  if (provider === 'openai') {
    return env.OPENAI_API_KEY;
  }
  return undefined;
}

function providerApiKeyName(provider: Exclude<EmbeddingProviderName, 'deterministic'>): string {
  return provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
}

function missingApiKeyError(provider: Exclude<EmbeddingProviderName, 'deterministic'>): Error {
  return new Error(
    `PUFU_LENS_EMBEDDING_API_KEY or ${providerApiKeyName(provider)} is required for ${provider} embedding.`,
  );
}

function unavailableEmbeddingProvider(
  config: EmbeddingRuntimeConfig,
  provider: Exclude<EmbeddingProviderName, 'deterministic'>,
): EmbeddingProvider {
  return {
    dimensions: config.dimensions,
    model: config.model,
    provider,
    async embedTexts() {
      throw missingApiKeyError(provider);
    },
  };
}
