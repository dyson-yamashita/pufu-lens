import assert from 'node:assert/strict';
import { updatePendingAssistantProgress } from './chat-thread-message-state.ts';

const pendingMessages = updatePendingAssistantProgress(
  [{ id: 'assistant-1', role: 'assistant', status: 'pending' }],
  'assistant-1',
  '関連資料を検索しています',
);
const pendingMessage = pendingMessages[0];
assert.ok(
  pendingMessage && pendingMessage.role === 'assistant' && pendingMessage.status === 'pending',
);
if (pendingMessage?.role === 'assistant' && pendingMessage.status === 'pending') {
  assert.equal(pendingMessage.progressLabel, '関連資料を検索しています');
}

console.log('chat-thread-message-state tests passed');
