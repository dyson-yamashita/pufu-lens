import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ADMIN_INGEST_EMBEDDING_PROVIDER,
  resolveAdminIngestEmbeddingProvider,
} from './admin-ingest-runtime.ts';

test('Admin ingestion defaults to Gemini embeddings', () => {
  assert.equal(DEFAULT_ADMIN_INGEST_EMBEDDING_PROVIDER, 'gemini');
  assert.equal(resolveAdminIngestEmbeddingProvider({}), 'gemini');
});

test('Admin ingestion permits an explicit deterministic provider for local and test use', () => {
  assert.equal(
    resolveAdminIngestEmbeddingProvider({ PUFU_LENS_EMBEDDING_PROVIDER: 'deterministic' }),
    'deterministic',
  );
  assert.equal(
    resolveAdminIngestEmbeddingProvider({
      NODE_ENV: 'test',
      PUFU_LENS_EMBEDDING_PROVIDER: 'deterministic',
    }),
    'deterministic',
  );
  assert.equal(
    resolveAdminIngestEmbeddingProvider({ PUFU_LENS_EMBEDDING_PROVIDER: 'gemini' }),
    'gemini',
  );
  assert.equal(
    resolveAdminIngestEmbeddingProvider({ PUFU_LENS_EMBEDDING_PROVIDER: 'openai' }),
    'openai',
  );
});

test('Admin ingestion rejects deterministic provider in production runtime', () => {
  assert.throws(
    () =>
      resolveAdminIngestEmbeddingProvider({
        NODE_ENV: 'production',
        PUFU_LENS_EMBEDDING_PROVIDER: 'deterministic',
      }),
    /not allowed when NODE_ENV=production/,
  );
});

test('Admin ingestion continues to accept gemini and openai in production runtime', () => {
  assert.equal(
    resolveAdminIngestEmbeddingProvider({
      NODE_ENV: 'production',
      PUFU_LENS_EMBEDDING_PROVIDER: 'gemini',
    }),
    'gemini',
  );
  assert.equal(
    resolveAdminIngestEmbeddingProvider({
      NODE_ENV: 'production',
      PUFU_LENS_EMBEDDING_PROVIDER: 'openai',
    }),
    'openai',
  );
});

test('Admin ingestion rejects empty and unsupported provider settings', () => {
  assert.throws(
    () => resolveAdminIngestEmbeddingProvider({ PUFU_LENS_EMBEDDING_PROVIDER: '' }),
    /must be one of/,
  );
  assert.throws(
    () =>
      resolveAdminIngestEmbeddingProvider({ PUFU_LENS_EMBEDDING_PROVIDER: 'gemini-embedding-2' }),
    /must be one of/,
  );
});
