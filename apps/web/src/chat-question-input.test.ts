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

assert.deepEqual(chatQuestionTextareaPresentation(), {
  className: 'chat-question-input',
  maxRows: 4,
  minRows: 1,
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
  assertClassIncludes(collapsedMarkup, 'chat-question-input');
  assert.equal(markupAttribute(collapsedMarkup, 'data-testid'), 'chat-question-input');

  const multilineMarkup = renderChatQuestionTextarea('1行目\n2行目\n3行目\n4行目\n5行目');
  assertClassIncludes(multilineMarkup, 'chat-question-input');
  assert.match(multilineMarkup, /1行目\s*2行目\s*3行目\s*4行目\s*5行目/);
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
