import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatQuestionTextarea } from './chat-question-input.ts';

function renderChatQuestionTextarea(value: string): string {
  return renderToStaticMarkup(
    createElement(ChatQuestionTextarea, {
      disabled: false,
      id: 'chat-question',
      onChange() {},
      testId: 'chat-question-input',
      value,
    }),
  );
}

const originalWindow = globalThis.window;

try {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      matchMedia() {
        throw new Error('SSR render must not read window.matchMedia.');
      },
    },
  });

  const collapsedMarkup = renderChatQuestionTextarea('');
  assert.match(collapsedMarkup, /class="chat-question-input-collapsed"/);
  assert.match(collapsedMarkup, /rows="1"/);

  const expandedMarkup = renderChatQuestionTextarea('質問があります');
  assert.match(expandedMarkup, /class="chat-question-input-expanded"/);
  assert.match(expandedMarkup, /rows="3"/);
} finally {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
}

console.log('chat-question-input.test.ts passed');
