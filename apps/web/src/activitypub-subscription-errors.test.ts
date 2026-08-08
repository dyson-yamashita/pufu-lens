import assert from 'node:assert/strict';
import test from 'node:test';
import { mapActivityPubSubscriptionErrorMessage } from './activitypub-subscription-errors.ts';

test('mapActivityPubSubscriptionErrorMessage returns generic message for unexpected errors', () => {
  assert.equal(
    mapActivityPubSubscriptionErrorMessage(new Error('SELECT * FROM secrets')),
    'Unable to update ActivityPub subscription. Try again later.',
  );
});

test('mapActivityPubSubscriptionErrorMessage maps blocked domain failures', () => {
  assert.equal(
    mapActivityPubSubscriptionErrorMessage(new Error('Remote domain is blocked')),
    'This remote domain cannot be subscribed.',
  );
});

test('mapActivityPubSubscriptionErrorMessage maps resolver failures', () => {
  assert.equal(
    mapActivityPubSubscriptionErrorMessage(new Error('WebFinger subject mismatch')),
    'The remote actor address could not be resolved.',
  );
});
