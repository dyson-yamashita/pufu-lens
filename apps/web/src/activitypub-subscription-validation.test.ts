import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityPubSubscriptionError } from './activitypub-subscription-errors.ts';
import {
  validateSubscriptionProjectSlugOrThrow,
  validateSubscriptionRemoteActorAddressOrThrow,
  validateSubscriptionRemoteActorUriOrThrow,
} from './activitypub-subscription-validation.ts';

test('validateSubscriptionProjectSlugOrThrow accepts canonical slugs', () => {
  validateSubscriptionProjectSlugOrThrow('sample-project');
});

test('validateSubscriptionRemoteActorAddressOrThrow accepts handles and HTTPS URLs', () => {
  validateSubscriptionRemoteActorAddressOrThrow('@alice@remote.example');
  validateSubscriptionRemoteActorAddressOrThrow('https://remote.example/users/alice');
});

test('validateSubscriptionRemoteActorUriOrThrow accepts HTTPS URLs', () => {
  validateSubscriptionRemoteActorUriOrThrow('https://remote.example/users/alice');
});

test('validation errors use ActivityPubSubscriptionError codes', () => {
  assert.throws(
    () => validateSubscriptionProjectSlugOrThrow('a'),
    (error: unknown) =>
      error instanceof ActivityPubSubscriptionError && error.code === 'invalid_slug',
  );
  assert.throws(
    () => validateSubscriptionRemoteActorAddressOrThrow('bad'),
    (error: unknown) =>
      error instanceof ActivityPubSubscriptionError && error.code === 'invalid_actor_address',
  );
  assert.throws(
    () =>
      validateSubscriptionRemoteActorAddressOrThrow('https://remote.example/users/alice#fragment'),
    (error: unknown) =>
      error instanceof ActivityPubSubscriptionError && error.code === 'invalid_actor_address',
  );
  assert.throws(
    () => validateSubscriptionRemoteActorUriOrThrow('http://remote.example/users/alice'),
    (error: unknown) =>
      error instanceof ActivityPubSubscriptionError && error.code === 'invalid_actor_address',
  );
});
