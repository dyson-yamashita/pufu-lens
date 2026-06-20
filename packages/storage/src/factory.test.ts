import assert from 'node:assert/strict';
import test from 'node:test';
import { createObjectStorageFromEnv } from './factory.ts';
import { GcsObjectStorage } from './gcs.ts';
import { LocalFsObjectStorage } from './local-fs.ts';

test('createObjectStorageFromEnv creates local storage', () => {
  const storage = createObjectStorageFromEnv({
    STORAGE_DRIVER: 'local',
    STORAGE_ROOT: '/tmp/pufu-lens-storage-test',
  });

  assert.equal(storage instanceof LocalFsObjectStorage, true);
});

test('createObjectStorageFromEnv creates GCS storage', () => {
  const storage = createObjectStorageFromEnv({
    STORAGE_BUCKET: 'pufu-lens-test',
    STORAGE_DRIVER: 'gcs',
  });

  assert.equal(storage instanceof GcsObjectStorage, true);
});

test('createObjectStorageFromEnv requires a GCS bucket', () => {
  assert.throws(
    () =>
      createObjectStorageFromEnv({
        STORAGE_DRIVER: 'gcs',
      }),
    /STORAGE_BUCKET or GCS_BUCKET is required/,
  );
});
