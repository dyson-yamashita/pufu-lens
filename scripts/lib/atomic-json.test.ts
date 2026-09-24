import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeAtomicJson } from './atomic-json.ts';

test('atomic report replacement preserves prior evidence on failure and cleans temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pufu-report-test-'));
  const path = join(directory, 'report.json');
  try {
    await writeFile(path, '{"old":true}\n');
    await assert.rejects(writeAtomicJson(path, { invalid: 1n }));
    await assert.rejects(writeAtomicJson(path, undefined));
    assert.equal(await readFile(path, 'utf8'), '{"old":true}\n');
    await writeAtomicJson(path, { gate: false });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { gate: false });
    assert.deepEqual(await readdir(directory), ['report.json']);

    const blocked = join(directory, 'blocked');
    await mkdir(blocked);
    await writeFile(join(blocked, 'evidence'), 'retained');
    await assert.rejects(writeAtomicJson(blocked, { gate: true }));
    assert.equal(await readFile(join(blocked, 'evidence'), 'utf8'), 'retained');
    assert.deepEqual((await readdir(directory)).sort(), ['blocked', 'report.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
