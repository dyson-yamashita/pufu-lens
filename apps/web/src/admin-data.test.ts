import assert from 'node:assert/strict';
import {
  availabilityFromConnections,
  DATA_SOURCE_SNIPPET_MAX_LENGTH,
  filterPublicProjectsExcludingMemberProjects,
  getFallbackDataSourceContentPreview,
  getProject,
  getSourceTypeCounts,
  isProjectVisibility,
  isSourceType,
  isSourceTypeAvailable,
  listProjects,
  listPublicProjects,
  notConnectedProjectConnections,
  requiredProviderForSourceType,
  truncateSnippet,
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
assert.deepEqual(
  filterPublicProjectsExcludingMemberProjects(publicProjects, projects).map(
    (project) => project.slug,
  ),
  [],
);
assert.deepEqual(
  filterPublicProjectsExcludingMemberProjects(publicProjects, [getProject('sample-b')]).map(
    (project) => project.slug,
  ),
  ['sample-a'],
);

assert.equal(requiredProviderForSourceType('web'), null);
assert.equal(requiredProviderForSourceType('github'), 'github');
assert.equal(requiredProviderForSourceType('gmail'), 'google');
assert.equal(requiredProviderForSourceType('drive'), 'google');
assert.equal(isSourceType('web'), true);
assert.equal(isSourceType('github'), true);
assert.equal(isSourceType('slack'), false);
assert.equal(isSourceType(null), false);
assert.equal(isProjectVisibility('public'), true);
assert.equal(isProjectVisibility('private'), true);
assert.equal(isProjectVisibility('internal'), false);
assert.equal(isProjectVisibility(null), false);

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

assert.equal(truncateSnippet('  hello   world  ', 20), 'hello world');
assert.equal(
  truncateSnippet('a'.repeat(DATA_SOURCE_SNIPPET_MAX_LENGTH + 10), DATA_SOURCE_SNIPPET_MAX_LENGTH)
    .length,
  DATA_SOURCE_SNIPPET_MAX_LENGTH,
);
assert.match(
  truncateSnippet('a'.repeat(DATA_SOURCE_SNIPPET_MAX_LENGTH + 10), DATA_SOURCE_SNIPPET_MAX_LENGTH),
  /…$/,
);

const webPreview = getFallbackDataSourceContentPreview('sample-a-web-docs');
assert.ok(webPreview);
assert.equal(webPreview.documents.length, 2);
const firstDocument = webPreview.documents[0];
assert.ok(firstDocument);
assert.ok(firstDocument.snippet.length > 0);
assert.equal(getFallbackDataSourceContentPreview('unknown-source-id'), null);

const githubPreview = getFallbackDataSourceContentPreview('sample-a-github-main');
assert.ok(githubPreview);
assert.equal(githubPreview.queue.length, 2);
const firstQueueItem = githubPreview.queue[0];
assert.ok(firstQueueItem);
assert.ok(firstQueueItem.lastErrorSummary);

console.log('web admin data tests passed');
