import assert from 'node:assert/strict';
import test from 'node:test';
import { GcsObjectStorage } from './gcs.js';

test('GcsObjectStorage builds gs:// URIs and project prefixes', async () => {
  const storage = new GcsObjectStorage('pufu-lens-test');
  const prefixes = await storage.ensureProjectPrefixes('project-a');

  assert.deepEqual(prefixes, {
    parsed: 'gs://pufu-lens-test/project-a/parsed',
    raw: 'gs://pufu-lens-test/project-a/raw',
    reports: 'gs://pufu-lens-test/project-a/reports',
  });
  assert.equal(
    storage.uriForRelativePath('project-a/reports/report.json'),
    'gs://pufu-lens-test/project-a/reports/report.json',
  );
});

test('GcsObjectStorage rejects traversal and bucket mismatches', async () => {
  const storage = new GcsObjectStorage('pufu-lens-test');

  assert.throws(() => storage.uriForRelativePath('../outside.json'), /escapes bucket prefix/);
  await assert.rejects(
    () => storage.exists('gs://other-bucket/project-a/raw/doc.json'),
    /bucket mismatch/,
  );
});
