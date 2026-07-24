import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_GITHUB_LIFECYCLE_BATCH_SIZE,
  MAX_GITHUB_LIFECYCLE_LIMIT,
  MAX_GITHUB_LIFECYCLE_MAX_RUNTIME_SECONDS,
  parseGitHubLifecycleCliOptions,
  readBoundedPositiveInt,
} from './github-lifecycle-cli-options.ts';
import { parseGitHubLifecycleTargetRow } from './github-lifecycle-row-parsers.ts';

test('parseGitHubLifecycleCliOptions applies defaults and validates UUID data source scope', () => {
  const options = parseGitHubLifecycleCliOptions([
    '--project',
    'sample-a',
    '--data-source-id',
    '00000000-0000-0000-0000-000000000010',
  ]);
  assert.equal(options.project, 'sample-a');
  assert.equal(options.dataSourceId, '00000000-0000-0000-0000-000000000010');
  assert.equal(options.dryRun, false);
});

test('parseGitHubLifecycleCliOptions rejects invalid numeric bounds', () => {
  assert.throws(
    () => parseGitHubLifecycleCliOptions(['--project', 'sample-a', '--limit', '0']),
    /--limit must be a positive integer/,
  );
  assert.throws(
    () => parseGitHubLifecycleCliOptions(['--project', 'sample-a', '--limit', '-5']),
    /--limit must be a positive integer/,
  );
  assert.throws(
    () =>
      parseGitHubLifecycleCliOptions([
        '--project',
        'sample-a',
        '--batch-size',
        String(MAX_GITHUB_LIFECYCLE_BATCH_SIZE + 1),
      ]),
    /--batch-size must be <=/,
  );
  assert.throws(
    () => parseGitHubLifecycleCliOptions(['--project', 'sample-a', '--limit', 'NaN']),
    /--limit must be a positive integer/,
  );
});

test('parseGitHubLifecycleCliOptions accepts resume-after for bounded retries', () => {
  const options = parseGitHubLifecycleCliOptions([
    '--project',
    'sample-a',
    '--resume-after',
    'example-org/repo/issues/101',
    '--limit',
    '10',
  ]);
  assert.equal(options.resumeAfter, 'example-org/repo/issues/101');
  assert.equal(options.limit, 10);
});

test('parseGitHubLifecycleCliOptions uses a higher default limit for backfill mode', () => {
  const reconcile = parseGitHubLifecycleCliOptions(['--project', 'sample-a']);
  const backfill = parseGitHubLifecycleCliOptions(['--project', 'sample-a', '--mode', 'backfill']);
  assert.equal(reconcile.mode, 'reconcile');
  assert.equal(reconcile.limit, 50);
  assert.equal(backfill.mode, 'backfill');
  assert.equal(backfill.limit, MAX_GITHUB_LIFECYCLE_LIMIT);
});

test('readBoundedPositiveInt enforces upper bounds', () => {
  assert.equal(readBoundedPositiveInt('10', '--limit', MAX_GITHUB_LIFECYCLE_LIMIT), 10);
  assert.throws(
    () =>
      readBoundedPositiveInt(
        String(MAX_GITHUB_LIFECYCLE_MAX_RUNTIME_SECONDS + 1),
        '--max-runtime-seconds',
        MAX_GITHUB_LIFECYCLE_MAX_RUNTIME_SECONDS,
      ),
    /--max-runtime-seconds must be <=/,
  );
});

test('parseGitHubLifecycleTargetRow preserves connection and metadata fields', () => {
  const target = parseGitHubLifecycleTargetRow({
    connectionId: '00000000-0000-0000-0000-000000000101',
    dataSourceId: '00000000-0000-0000-0000-000000000010',
    kind: 'issue',
    lifecycleState: 'closed',
    logicalSourceId: 'example-org/repo/issues/101',
    metadata: {
      githubLifecycle: {
        closedAt: '2026-05-08T12:00:00.000Z',
        draft: null,
        kind: 'issue',
        merged: null,
        mergedAt: null,
        state: 'closed',
        stateReason: 'completed',
        statusKnown: true,
        updatedAt: '2026-05-08T12:00:00.000Z',
      },
      number: 101,
      repository: 'example-org/repo',
    },
    number: 101,
    projectId: '00000000-0000-0000-0000-000000000001',
    projectSlug: 'sample-a',
    rawDocumentId: '00000000-0000-0000-0000-000000000020',
    repository: 'example-org/repo',
    sourceUri: 'https://github.com/example-org/repo/issues/101',
    sourceVersion: 'v1',
    storageUri: 'sample-a/raw/github/issue.json',
  });
  assert.equal(target.connectionId, '00000000-0000-0000-0000-000000000101');
  assert.equal(target.rawMetadata.repository, 'example-org/repo');
  assert.equal(target.rawMetadata.number, 101);
  assert.equal(target.lifecycle?.state, 'closed');
});
