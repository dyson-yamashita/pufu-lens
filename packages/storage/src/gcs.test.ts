import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import type { Storage } from '@google-cloud/storage';
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

test('GcsObjectStorage put returns local sha256 etag without reading metadata', async () => {
  const fakeFile = {
    name: 'project-a/raw/doc.txt',
    async save(body: Buffer) {
      assert.equal(body.toString('utf8'), 'hello');
    },
    async getMetadata() {
      throw new Error('getMetadata should not be called after put');
    },
  };
  const storage = new GcsObjectStorage({
    bucket: 'pufu-lens-test',
    storage: fakeStorage(fakeFile),
  });

  const result = await storage.put('project-a/raw/doc.txt', 'hello');

  assert.equal(result.uri, 'gs://pufu-lens-test/project-a/raw/doc.txt');
  assert.equal(result.etag, createHash('sha256').update('hello').digest('hex'));
});

test('GcsObjectStorage list streams files and signedUrl uses v4', async () => {
  const signedUrlOptions: Array<Record<string, unknown>> = [];
  const files = [
    fakeFile('project-a/raw/a.txt', { size: '1', updated: '2026-06-19T00:00:00.000Z' }),
    fakeFile('project-a/raw/b.txt', { size: '2', updated: '2026-06-19T00:01:00.000Z' }),
  ];
  const storage = new GcsObjectStorage({
    bucket: 'pufu-lens-test',
    storage: fakeStorage(fakeFile('project-a/raw/a.txt', {}, signedUrlOptions), files),
  });

  const listed = [];
  for await (const item of storage.list('project-a/raw')) {
    listed.push(item);
  }
  const signedUrl = await storage.signedUrl('project-a/raw/a.txt', 60);

  assert.deepEqual(
    listed.map((item) => item.uri),
    ['gs://pufu-lens-test/project-a/raw/a.txt', 'gs://pufu-lens-test/project-a/raw/b.txt'],
  );
  assert.equal(signedUrl, 'https://signed.example.test/project-a/raw/a.txt');
  assert.equal(signedUrlOptions[0]?.version, 'v4');
});

function fakeStorage(file: unknown, streamedFiles: unknown[] = []): Storage {
  return {
    bucket() {
      return {
        file() {
          return file;
        },
        getFiles() {
          throw new Error('getFiles should not be used for list');
        },
        getFilesStream() {
          return Readable.from(streamedFiles);
        },
      };
    },
  } as unknown as Storage;
}

function fakeFile(
  name: string,
  metadata: Record<string, unknown> = {},
  signedUrlOptions?: Array<Record<string, unknown>>,
) {
  return {
    metadata,
    name,
    createWriteStream() {
      return new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
    },
    async exists() {
      return [true];
    },
    async getSignedUrl(options: Record<string, unknown>) {
      signedUrlOptions?.push(options);
      return [`https://signed.example.test/${name}`];
    },
  };
}
