import assert from 'node:assert/strict';
import {
  availabilityFromConnections,
  getProject,
  getSourceTypeCounts,
  isSourceTypeAvailable,
  listProjects,
  listPublicProjects,
  notConnectedProjectConnections,
  requiredProviderForSourceType,
} from './admin-data.ts';

const projects = listProjects();

assert.equal(projects.length, 2);
assert.equal(getProject('sample-a').failedCount, 2);
assert.equal(getProject('sample-b').failedCount, 0);
assert.equal(getProject('sample-a').visibility, 'public');
assert.equal(getProject('sample-b').visibility, 'private');
assert.equal(
  getProject('sample-a').description,
  '公開レポートと Public Chat を確認できるサンプルプロジェクトです。',
);
assert.equal(
  getProject('sample-b').description,
  'private project の操作確認に使うサンプルプロジェクトです。',
);
assert.notDeepEqual(
  getProject('sample-a').dataSources.map((source) => source.id),
  getProject('sample-b').dataSources.map((source) => source.id),
);

const sampleACounts = getSourceTypeCounts(getProject('sample-a'));
assert.equal(sampleACounts.web, 1);
assert.equal(sampleACounts.github, 1);
assert.equal(sampleACounts.drive, 1);
assert.equal(sampleACounts.gmail, 0);

const publicProjects = listPublicProjects();
assert.equal(publicProjects.length, 1);
assert.equal(publicProjects[0]?.slug, 'sample-a');
assert.equal(publicProjects[0]?.reports[0]?.id, 'report-a');

assert.equal(requiredProviderForSourceType('web'), null);
assert.equal(requiredProviderForSourceType('github'), 'github');
assert.equal(requiredProviderForSourceType('gmail'), 'google');
assert.equal(requiredProviderForSourceType('drive'), 'google');

const disconnected = notConnectedProjectConnections();
assert.equal(disconnected.length, 2);
assert.equal(isSourceTypeAvailable('web', disconnected), true);
assert.equal(isSourceTypeAvailable('github', disconnected), false);
assert.equal(isSourceTypeAvailable('gmail', disconnected), false);
assert.equal(isSourceTypeAvailable('drive', disconnected), false);

const availability = availabilityFromConnections(disconnected);
assert.deepEqual(availability, {
  drive: false,
  github: false,
  gmail: false,
  web: true,
});

const connectedGoogle = disconnected.map((connection) =>
  connection.provider === 'google' ? { ...connection, status: 'connected' as const } : connection,
);
assert.equal(isSourceTypeAvailable('gmail', connectedGoogle), false);
assert.equal(isSourceTypeAvailable('drive', connectedGoogle), false);
assert.equal(isSourceTypeAvailable('github', connectedGoogle), false);

const connectedGoogleWithScopes = disconnected.map((connection) =>
  connection.provider === 'google'
    ? {
        ...connection,
        grantedScopes: [
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/gmail.readonly',
        ],
        status: 'connected' as const,
      }
    : connection,
);
assert.equal(isSourceTypeAvailable('gmail', connectedGoogleWithScopes), true);
assert.equal(isSourceTypeAvailable('drive', connectedGoogleWithScopes), true);
assert.equal(isSourceTypeAvailable('github', connectedGoogleWithScopes), false);

const expiredGoogleWithDriveScope = disconnected.map((connection) =>
  connection.provider === 'google'
    ? {
        ...connection,
        grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'],
        status: 'expired' as const,
      }
    : connection,
);
assert.equal(isSourceTypeAvailable('drive', expiredGoogleWithDriveScope), true);
assert.equal(isSourceTypeAvailable('gmail', expiredGoogleWithDriveScope), false);

console.log('web admin data tests passed');
