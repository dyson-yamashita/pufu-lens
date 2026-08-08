import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActivityPubTestRuntimeDisabledError,
  assertActivityPubListenerHarnessRuntime,
} from './test-runtime-guard.ts';

function restoreNodeEnv(previous: string | undefined) {
  if (previous === undefined) {
    delete process.env.NODE_ENV;
    return;
  }
  process.env.NODE_ENV = previous;
}

test('assertActivityPubListenerHarnessRuntime allows NODE_ENV=test', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    assertActivityPubListenerHarnessRuntime();
  } finally {
    restoreNodeEnv(previous);
  }
});

test('assertActivityPubListenerHarnessRuntime rejects unset, development, production, and staging', () => {
  const previous = process.env.NODE_ENV;
  for (const nodeEnv of [undefined, 'development', 'production', 'staging']) {
    if (nodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = nodeEnv;
    }
    assert.throws(
      () => assertActivityPubListenerHarnessRuntime(),
      (error: unknown) => error instanceof ActivityPubTestRuntimeDisabledError,
    );
  }
  restoreNodeEnv(previous);
});
