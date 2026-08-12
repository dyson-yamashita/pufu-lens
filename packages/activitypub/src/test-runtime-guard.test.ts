import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActivityPubTestRuntimeDisabledError,
  assertActivityPubHermeticE2eRuntime,
  assertActivityPubListenerHarnessRuntime,
  assertTestDeliveryFetchTimeoutMsAllowed,
  assertTestRemoteArticleResolverAllowed,
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

test('assertTestRemoteArticleResolverAllowed rejects when ACTIVITYPUB_RUN_DB_TESTS is unset', () => {
  const previous = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  delete process.env.ACTIVITYPUB_RUN_DB_TESTS;
  try {
    assert.throws(
      () =>
        assertTestRemoteArticleResolverAllowed({
          resolve: async () => ({
            articleId: 'https://example.test/article',
            attributedTo: 'https://example.test/actor',
            title: 't',
            summaryHtml: 's',
            originalUrl: 'https://example.test/report',
            publishedAt: null,
            updatedAt: null,
          }),
        }),
      (error: unknown) => error instanceof ActivityPubTestRuntimeDisabledError,
    );
  } finally {
    restoreEnv('ACTIVITYPUB_RUN_DB_TESTS', previous);
  }
});

test('assertTestDeliveryFetchTimeoutMsAllowed accepts positive integer in hermetic runtime', () => {
  const previousDb = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  const previousHermetic = process.env.ACTIVITYPUB_RUN_HERMETIC_E2E;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.ACTIVITYPUB_RUN_DB_TESTS = '1';
  process.env.ACTIVITYPUB_RUN_HERMETIC_E2E = '1';
  process.env.NODE_ENV = 'test';
  try {
    assertActivityPubHermeticE2eRuntime();
    assertTestDeliveryFetchTimeoutMsAllowed(1000);
  } finally {
    restoreEnv('ACTIVITYPUB_RUN_DB_TESTS', previousDb);
    restoreEnv('ACTIVITYPUB_RUN_HERMETIC_E2E', previousHermetic);
    restoreEnv('NODE_ENV', previousNodeEnv);
  }
});

function restoreEnv(name: string, previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}
