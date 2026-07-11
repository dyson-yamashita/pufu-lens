import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultDeployStateBucket,
  deployStateObjectPath,
  parseStoredCommitSha,
} from './apphosting-deploy-state.ts';

test('defaultDeployStateBucket uses Cloud Build default bucket naming', () => {
  assert.equal(defaultDeployStateBucket('pufu-lens'), 'pufu-lens_cloudbuild');
});

test('deployStateObjectPath is env-scoped', () => {
  assert.equal(
    deployStateObjectPath('staging'),
    'pufu-lens/deploy-state/staging/apphosting-last-success',
  );
  assert.equal(
    deployStateObjectPath('production'),
    'pufu-lens/deploy-state/production/apphosting-last-success',
  );
  assert.throws(() => deployStateObjectPath('dev'), /staging or production/);
});

test('parseStoredCommitSha accepts git shas and rejects junk', () => {
  assert.equal(
    parseStoredCommitSha('  abcdef0123456789abcdef0123456789abcdef01 \n'),
    'abcdef0123456789abcdef0123456789abcdef01',
  );
  assert.equal(parseStoredCommitSha('deadbee'), 'deadbee');
  assert.equal(parseStoredCommitSha(''), null);
  assert.equal(parseStoredCommitSha('not-a-sha'), null);
});
