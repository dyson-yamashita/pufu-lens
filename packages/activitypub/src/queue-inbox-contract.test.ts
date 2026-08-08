import assert from 'node:assert/strict';
import test from 'node:test';
import { createFedifyInboxMessageFixture } from './fedify-message-fixture.ts';
import {
  extractHttpsActivityId,
  parsePinnedInboxMessage,
  UnsupportedFedifyQueueMessageError,
} from './queue.ts';

test('parsePinnedInboxMessage accepts Fedify 2.3.4 inbox message fields', () => {
  const fixture = createFedifyInboxMessageFixture({
    baseUrl: 'https://lens.test',
    activity: {
      id: 'https://remote.example/activities/follow-1',
      type: 'Follow',
      actor: 'https://remote.example/users/alice',
      object: 'https://lens.test/activitypub/actors/sample-project',
    },
  });
  const withOptional = {
    ...fixture,
    normalizedActivity: {
      id: 'https://remote.example/activities/follow-1',
      type: 'Follow',
    },
    ldSignatureVerified: true,
  };
  const parsed = parsePinnedInboxMessage(withOptional);
  assert.equal(parsed.type, 'inbox');
  assert.equal(parsed.normalizedActivity, withOptional.normalizedActivity);
  assert.equal(parsed.ldSignatureVerified, true);
  assert.equal(parsed.identifier, 'pufu');
});

test('extractHttpsActivityId rejects invalid, non-HTTPS, and normalizes HTTPS inbox activity ids', () => {
  assert.throws(
    () => extractHttpsActivityId({ id: 'not-a-url' }),
    UnsupportedFedifyQueueMessageError,
  );
  assert.throws(
    () => extractHttpsActivityId({ id: 'http://remote.example/activities/follow-1' }),
    /must use HTTPS/,
  );
  assert.equal(
    extractHttpsActivityId({ id: 'https://remote.example/activities/follow-1/' }),
    'https://remote.example/activities/follow-1/',
  );
});
