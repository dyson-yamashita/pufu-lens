import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ADMIN_INGEST_EMBEDDING_PROVIDER,
  resolveAdminIngestEmbeddingProvider,
} from './admin-ingest-runtime.ts';

test('Admin ingestion defaults to Gemini embeddings', () => {
  assert.equal(DEFAULT_ADMIN_INGEST_EMBEDDING_PROVIDER, 'gemini');
  assert.equal(resolveAdminIngestEmbeddingProvider(undefined), 'gemini');
});

test('Admin ingestion permits an explicit deterministic provider for local and test use', () => {
  assert.equal(resolveAdminIngestEmbeddingProvider('deterministic'), 'deterministic');
  assert.equal(resolveAdminIngestEmbeddingProvider('gemini'), 'gemini');
  assert.equal(resolveAdminIngestEmbeddingProvider('openai'), 'openai');
});

test('Admin ingestion rejects empty and unsupported provider settings', () => {
  assert.throws(() => resolveAdminIngestEmbeddingProvider(''), /must be one of/);
  assert.throws(() => resolveAdminIngestEmbeddingProvider('gemini-embedding-2'), /must be one of/);
});
