import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatEmbeddingProvider } from './chat-embedding-provider.ts';

test('createChatEmbeddingProvider keeps builds secret-free and fails only when invoked', async () => {
  const provider = createChatEmbeddingProvider({});
  assert.equal(provider.dimensions, 1536);
  assert.equal(provider.model, 'gemini-embedding-2');
  await assert.rejects(() => provider.embedTexts(['query']), /GEMINI_API_KEY is required/);
});

test('createChatEmbeddingProvider rejects dimensions that do not match document chunks', () => {
  assert.throws(
    () => createChatEmbeddingProvider({ GEMINI_EMBEDDING_DIMENSIONS: '768' }),
    /must be 1536/,
  );
});

test('createChatEmbeddingProvider configures Gemini with the selected shared model', () => {
  const provider = createChatEmbeddingProvider({
    GEMINI_API_KEY: 'test-key',
    GEMINI_EMBEDDING_DIMENSIONS: '1536',
    GEMINI_EMBEDDING_MODEL: 'gemini-test',
  });
  assert.equal(provider.dimensions, 1536);
  assert.equal(provider.model, 'gemini-test');
});
