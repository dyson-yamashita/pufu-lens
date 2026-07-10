import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveStoredSourceIdentity,
  driveLogicalSourceId,
  driveSourceVersion,
  githubLogicalSourceId,
  githubSourceVersion,
  gmailLogicalSourceId,
  gmailSourceVersion,
  legacyLogicalSourceId,
  webLogicalSourceId,
  webSourceVersion,
} from './source-version-identity.js';

const contentHash = 'a'.repeat(64);

test('gmail identity uses thread ID and latest message ID', () => {
  assert.equal(gmailLogicalSourceId('thread-alpha'), 'thread-alpha');
  assert.equal(gmailSourceVersion('msg-alpha-002'), 'msg-alpha-002');
});

test('drive identity uses file ID and revision ID', () => {
  assert.equal(driveLogicalSourceId('file-123'), 'file-123');
  assert.equal(driveSourceVersion('rev-9'), 'rev-9');
});

test('github identity uses stable repository issue or pull ID and deterministic version', () => {
  assert.equal(
    githubLogicalSourceId({ kind: 'issue', number: 12, repository: 'Org/Repo' }),
    'org/repo/issues/12',
  );
  assert.equal(
    githubSourceVersion('2026-05-01T00:00:00.000Z', contentHash),
    `2026-05-01T00:00:00.000Z:${contentHash}`,
  );
});

test('web identity uses normalized configured URL and content hash version', () => {
  assert.equal(webLogicalSourceId('https://Example.test/docs/'), 'https://example.test/docs');
  assert.equal(webSourceVersion(contentHash), contentHash);
});

test('deriveStoredSourceIdentity falls back to legacy isolation when metadata is unavailable', () => {
  assert.deepEqual(
    deriveStoredSourceIdentity({
      contentHash,
      metadata: {},
      sourceId: 'orphan-source',
      sourceType: 'gmail',
    }),
    {
      logicalSourceId: legacyLogicalSourceId('orphan-source'),
      sourceVersion: contentHash,
    },
  );
});

test('deriveStoredSourceIdentity supports multiple raw versions under one gmail logical ID', () => {
  const first = deriveStoredSourceIdentity({
    contentHash: 'b'.repeat(64),
    metadata: { messageId: 'msg-001', threadId: 'thread-alpha' },
    sourceId: 'thread-alpha:msg-001',
    sourceType: 'gmail',
  });
  const second = deriveStoredSourceIdentity({
    contentHash: 'c'.repeat(64),
    metadata: { messageId: 'msg-002', threadId: 'thread-alpha' },
    sourceId: 'thread-alpha:msg-002',
    sourceType: 'gmail',
  });

  assert.equal(first.logicalSourceId, 'thread-alpha');
  assert.equal(second.logicalSourceId, 'thread-alpha');
  assert.notEqual(first.sourceVersion, second.sourceVersion);
});
