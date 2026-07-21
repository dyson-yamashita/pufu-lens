import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatEmbeddingProvider } from './chat-embedding-provider.ts';

test('createChatEmbeddingProvider keeps Gemini builds secret-free and fails only when invoked', async () => {
  const provider = createChatEmbeddingProvider({});
  assert.equal(provider.dimensions, 1536);
  assert.equal(provider.model, 'gemini-embedding-2');
  assert.equal(provider.provider, 'gemini');
  await assert.rejects(() => provider.embedTexts(['query']), /GEMINI_API_KEY is required/);
});

test('createChatEmbeddingProvider rejects dimensions that do not match document chunks', () => {
  assert.throws(
    () => createChatEmbeddingProvider({ PUFU_LENS_EMBEDDING_DIMENSIONS: '768' }),
    /must be 1536/,
  );
});

test('createChatEmbeddingProvider configures Gemini with legacy shared model settings', () => {
  const provider = createChatEmbeddingProvider({
    GEMINI_API_KEY: 'test-key',
    GEMINI_EMBEDDING_DIMENSIONS: '1536',
    GEMINI_EMBEDDING_MODEL: 'gemini-test',
  });
  assert.equal(provider.dimensions, 1536);
  assert.equal(provider.model, 'gemini-test');
});

test('createChatEmbeddingProvider configures OpenAI independently from the chat model', () => {
  const provider = createChatEmbeddingProvider({
    OPENAI_API_KEY: 'test-key',
    PUFU_LENS_CHAT_MODEL: 'anthropic/claude-sonnet-4-5',
    PUFU_LENS_EMBEDDING_DIMENSIONS: '1536',
    PUFU_LENS_EMBEDDING_MODEL: 'text-embedding-3-small',
    PUFU_LENS_EMBEDDING_PROVIDER: 'openai',
  });
  assert.equal(provider.provider, 'openai');
  assert.equal(provider.dimensions, 1536);
  assert.equal(provider.model, 'text-embedding-3-small');
});
