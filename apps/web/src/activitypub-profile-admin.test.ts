import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityPubActorProfileError } from '@pufu-lens/activitypub';
import { mapActivityPubProfileAdminError } from './activitypub-profile-admin.ts';

test('mapActivityPubProfileAdminError maps validation failures safely', () => {
  const mapped = mapActivityPubProfileAdminError(
    new ActivityPubActorProfileError('Icon URL path is invalid.'),
  );
  assert.equal(mapped.code, 'invalid_profile');
  assert.equal(mapped.status, 400);
});

test('mapActivityPubProfileAdminError maps missing actor errors', () => {
  const mapped = mapActivityPubProfileAdminError(
    new Error('Aggregate ActivityPub actor was not found.'),
  );
  assert.equal(mapped.code, 'actor_not_found');
  assert.equal(mapped.status, 404);
});

test('mapActivityPubProfileAdminError maps authorization failures', () => {
  const mapped = mapActivityPubProfileAdminError(new Error('Global admin access is required.'));
  assert.equal(mapped.code, 'forbidden');
  assert.equal(mapped.status, 403);
});
