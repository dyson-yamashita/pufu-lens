import assert from 'node:assert/strict';
import test from 'node:test';
import { createFedifyInboxMessageFixture } from './fedify-message-fixture.ts';
import { parsePinnedInboxMessage } from './queue.ts';

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
