import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertActivityPubSubscriptionE2eHarnessAllowed,
  isActivityPubSubscriptionE2eHarnessAllowed,
} from './activitypub-subscription-e2e-guard.ts';

test('isActivityPubSubscriptionE2eHarnessAllowed accepts development fixture runtime with explicit flag', () => {
  assert.equal(
    isActivityPubSubscriptionE2eHarnessAllowed({
      NODE_ENV: 'development',
      PUFU_LENS_ENABLE_FIXTURE_FALLBACK: 'true',
    }),
    true,
  );
  assert.equal(
    isActivityPubSubscriptionE2eHarnessAllowed({
      NODE_ENV: 'test',
      PUFU_LENS_ENABLE_FIXTURE_FALLBACK: 'true',
    }),
    true,
  );
});

test('isActivityPubSubscriptionE2eHarnessAllowed rejects production, unset flag, and missing flag', () => {
  assert.equal(
    isActivityPubSubscriptionE2eHarnessAllowed({
      NODE_ENV: 'production',
      PUFU_LENS_ENABLE_FIXTURE_FALLBACK: 'true',
    }),
    false,
  );
  assert.equal(
    isActivityPubSubscriptionE2eHarnessAllowed({
      NODE_ENV: 'development',
    }),
    false,
  );
  assert.equal(
    isActivityPubSubscriptionE2eHarnessAllowed({
      NODE_ENV: 'development',
      PUFU_LENS_ENABLE_FIXTURE_FALLBACK: 'false',
    }),
    false,
  );
});

test('assertActivityPubSubscriptionE2eHarnessAllowed rejects production and missing fixture flag', () => {
  assert.throws(
    () =>
      assertActivityPubSubscriptionE2eHarnessAllowed({
        NODE_ENV: 'production',
        PUFU_LENS_ENABLE_FIXTURE_FALLBACK: 'true',
      }),
    /disabled in production/,
  );
  assert.throws(
    () =>
      assertActivityPubSubscriptionE2eHarnessAllowed({
        NODE_ENV: 'development',
      }),
    /requires fixture fallback flag/,
  );
});
