import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEmbeddingProviderFromEnv,
  resolveEmbeddingRuntimeConfig,
} from './embedding-runtime.js';

test('generic embedding settings resolve Gemini by default', () => {
  assert.deepEqual(resolveEmbeddingRuntimeConfig({ env: {} }), {
    apiKey: undefined,
    dimensions: 1536,
    model: 'gemini-embedding-2',
    provider: 'gemini',
  });
});

test('generic embedding settings configure OpenAI independently from chat', () => {
  assert.deepEqual(
    resolveEmbeddingRuntimeConfig({
      env: {
        OPENAI_API_KEY: 'openai-secret',
        PUFU_LENS_EMBEDDING_DIMENSIONS: '1536',
        PUFU_LENS_EMBEDDING_MODEL: 'text-embedding-3-large',
        PUFU_LENS_EMBEDDING_PROVIDER: 'openai',
      },
    }),
    {
      apiKey: 'openai-secret',
      dimensions: 1536,
      model: 'text-embedding-3-large',
      provider: 'openai',
    },
  );
});

test('legacy Gemini embedding settings remain compatible', () => {
  assert.deepEqual(
    resolveEmbeddingRuntimeConfig({
      env: {
        GEMINI_API_KEY: 'gemini-secret',
        GEMINI_EMBEDDING_DIMENSIONS: '1536',
        GEMINI_EMBEDDING_MODEL: 'gemini-legacy',
      },
    }),
    {
      apiKey: 'gemini-secret',
      dimensions: 1536,
      model: 'gemini-legacy',
      provider: 'gemini',
    },
  );
});

test('embedding settings reject unsupported providers and vector dimensions', () => {
  assert.throws(
    () =>
      resolveEmbeddingRuntimeConfig({
        env: { PUFU_LENS_EMBEDDING_PROVIDER: 'anthropic' },
      }),
    /must be one of: deterministic, gemini, openai/,
  );
  assert.throws(
    () =>
      resolveEmbeddingRuntimeConfig({
        env: { PUFU_LENS_EMBEDDING_DIMENSIONS: '3072' },
      }),
    /must be 1536/,
  );
});

test('workflow provider override must match the shared runtime provider', () => {
  assert.throws(
    () =>
      resolveEmbeddingRuntimeConfig({
        env: { PUFU_LENS_EMBEDDING_PROVIDER: 'gemini' },
        provider: 'openai',
      }),
    /Embedding provider mismatch: workflow=openai, runtime=gemini/,
  );
});

test('build-safe provider preserves selected model and fails only when invoked', async () => {
  const provider = createEmbeddingProviderFromEnv({
    allowMissingApiKey: true,
    env: {
      PUFU_LENS_EMBEDDING_MODEL: 'text-embedding-3-small',
      PUFU_LENS_EMBEDDING_PROVIDER: 'openai',
    },
  });

  assert.equal(provider.provider, 'openai');
  assert.equal(provider.model, 'text-embedding-3-small');
  await assert.rejects(() => provider.embedTexts(['query']), /OPENAI_API_KEY is required/);
});

test('production runtime rejects deterministic provider from env, override, and default', () => {
  const productionEnv = { NODE_ENV: 'production' };
  const productionError = /not allowed when NODE_ENV=production/;

  assert.throws(
    () =>
      resolveEmbeddingRuntimeConfig({
        env: { ...productionEnv, PUFU_LENS_EMBEDDING_PROVIDER: 'deterministic' },
      }),
    productionError,
  );
  assert.throws(
    () =>
      resolveEmbeddingRuntimeConfig({
        env: productionEnv,
        provider: 'deterministic',
      }),
    productionError,
  );
  assert.throws(
    () =>
      resolveEmbeddingRuntimeConfig({
        defaultProvider: 'deterministic',
        env: productionEnv,
      }),
    productionError,
  );
  assert.throws(
    () =>
      createEmbeddingProviderFromEnv({
        defaultProvider: 'deterministic',
        env: productionEnv,
      }),
    productionError,
  );
});

test('deterministic provider remains available outside production runtime', () => {
  for (const nodeEnv of [undefined, 'test', 'development'] as const) {
    const env = nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv };
    assert.deepEqual(
      resolveEmbeddingRuntimeConfig({
        env: { ...env, PUFU_LENS_EMBEDDING_PROVIDER: 'deterministic' },
      }),
      {
        apiKey: undefined,
        dimensions: 1536,
        model: 'deterministic-sha256-v1',
        provider: 'deterministic',
      },
    );
    assert.deepEqual(
      resolveEmbeddingRuntimeConfig({
        defaultProvider: 'deterministic',
        env,
      }),
      {
        apiKey: undefined,
        dimensions: 1536,
        model: 'deterministic-sha256-v1',
        provider: 'deterministic',
      },
    );
  }
});

test('production runtime continues to resolve gemini and openai providers', () => {
  const productionEnv = { NODE_ENV: 'production' };

  assert.deepEqual(
    resolveEmbeddingRuntimeConfig({
      env: {
        ...productionEnv,
        GEMINI_API_KEY: 'gemini-secret',
        PUFU_LENS_EMBEDDING_PROVIDER: 'gemini',
      },
    }),
    {
      apiKey: 'gemini-secret',
      dimensions: 1536,
      model: 'gemini-embedding-2',
      provider: 'gemini',
    },
  );
  assert.deepEqual(
    resolveEmbeddingRuntimeConfig({
      env: {
        ...productionEnv,
        OPENAI_API_KEY: 'openai-secret',
        PUFU_LENS_EMBEDDING_PROVIDER: 'openai',
      },
    }),
    {
      apiKey: 'openai-secret',
      dimensions: 1536,
      model: 'text-embedding-3-small',
      provider: 'openai',
    },
  );
});
