import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CHAT_MODEL, resolveChatModel } from './model-runtime.ts';

test('chat model defaults to the provider-qualified Gemini model', () => {
  assert.equal(resolveChatModel({}), DEFAULT_CHAT_MODEL);
});

test('chat model accepts OpenAI and Anthropic Mastra model-router identifiers', () => {
  assert.equal(
    resolveChatModel({ PUFU_LENS_CHAT_MODEL: 'openai/gpt-5-mini' }),
    'openai/gpt-5-mini',
  );
  assert.equal(
    resolveChatModel({ PUFU_LENS_CHAT_MODEL: 'anthropic/claude-sonnet-4-5' }),
    'anthropic/claude-sonnet-4-5',
  );
});

test('legacy Gemini chat model is normalized to the Mastra Google provider', () => {
  assert.equal(
    resolveChatModel({ GEMINI_CHAT_MODEL: 'gemini-2.5-flash' }),
    'google/gemini-2.5-flash',
  );
});

test('generic chat model rejects empty and unqualified values', () => {
  assert.throws(() => resolveChatModel({ PUFU_LENS_CHAT_MODEL: '' }), /provider-qualified/);
  assert.throws(
    () => resolveChatModel({ PUFU_LENS_CHAT_MODEL: 'gemini-2.5-flash' }),
    /provider-qualified/,
  );
});
