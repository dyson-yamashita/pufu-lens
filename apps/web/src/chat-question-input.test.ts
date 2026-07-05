import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatQuestionTextarea, chatQuestionTextareaPresentation } from './chat-question-input.ts';

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

function markupAttribute(markup: string, name: string): string {
  const match = markup.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `Expected ${name} attribute in markup.`);
  return match[1] ?? '';
}

function assertClassIncludes(markup: string, className: string): void {
  assert.ok(
    markupAttribute(markup, 'class').split(/\s+/).includes(className),
    `Expected class ${className} in markup.`,
  );
}

const hadWindow = Object.hasOwn(globalThis, 'window');
const originalWindow = globalThis.window;

assert.deepEqual(chatQuestionTextareaPresentation({ focused: false, value: '' }), {
  className: 'chat-question-input-collapsed',
  rows: 1,
});
assert.deepEqual(chatQuestionTextareaPresentation({ focused: true, value: '' }), {
  className: 'chat-question-input-expanded',
  rows: 3,
});
assert.deepEqual(chatQuestionTextareaPresentation({ focused: false, value: '質問があります' }), {
  className: 'chat-question-input-expanded',
  rows: 3,
});

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
  assertClassIncludes(collapsedMarkup, 'chat-question-input-collapsed');
  assert.equal(markupAttribute(collapsedMarkup, 'rows'), '1');

  const expandedMarkup = renderChatQuestionTextarea('質問があります');
  assertClassIncludes(expandedMarkup, 'chat-question-input-expanded');
  assert.equal(markupAttribute(expandedMarkup, 'rows'), '3');
} finally {
  if (hadWindow) {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
}

console.log('chat-question-input.test.ts passed');
