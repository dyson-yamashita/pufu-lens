import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { LocalFsObjectStorage } from './local-fs.js';

test('LocalFsObjectStorage stores and reads text objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pufu-lens-storage-'));
  try {
    const storage = new LocalFsObjectStorage(root);
    const result = await storage.put('project-a/raw/doc.txt', 'hello');

    assert.equal(await storage.exists(result.uri), true);
    assert.equal(await storage.getText(result.uri), 'hello');
    assert.match(result.etag ?? '', /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('LocalFsObjectStorage lists only objects under the requested project prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pufu-lens-storage-'));
  try {
    const storage = new LocalFsObjectStorage(root);
    await storage.put('project-a/raw/a.txt', 'a');
    await storage.put('project-b/raw/b.txt', 'b');

    const listed = [];
    for await (const item of storage.list('project-a/raw')) {
      listed.push(item.uri);
    }

    assert.equal(listed.length, 1);
    assert.match(listed[0] ?? '', /project-a\/raw\/a\.txt$/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('LocalFsObjectStorage creates project storage prefixes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pufu-lens-storage-'));
  try {
    const storage = new LocalFsObjectStorage(root);
    const prefixes = await storage.ensureProjectPrefixes('project-a');

    assert.deepEqual(Object.keys(prefixes).sort(), ['parsed', 'raw', 'reports']);
    assert.equal(await storage.exists(prefixes.raw), true);
    assert.equal(await storage.exists(prefixes.parsed), true);
    assert.equal(await storage.exists(prefixes.reports), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('LocalFsObjectStorage accepts readable streams and rejects path traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pufu-lens-storage-'));
  try {
    const storage = new LocalFsObjectStorage(root);
    await storage.put('project-a/raw/stream.txt', Readable.from(['stream']));

    assert.equal(await storage.getText('project-a/raw/stream.txt'), 'stream');
    await assert.rejects(() => storage.put('../outside.txt', 'nope'), /escapes root/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
