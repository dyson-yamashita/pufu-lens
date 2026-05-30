import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  loadIngestionFixtureCases,
  parseRawFixture,
  validateParsedDocument,
} from './ingestion-fixtures.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('fixtures declare valid raw document contracts and matching content hashes', async () => {
  const fixtureCases = await loadIngestionFixtureCases();

  assert.equal(fixtureCases.length, 5);
  for (const fixtureCase of fixtureCases) {
    const rawContent = await readFile(join(repoRoot, fixtureCase.rawPath), 'utf8');
    const actualHash = createHash('sha256').update(rawContent).digest('hex');

    assert.equal(actualHash, fixtureCase.raw.contentHash, fixtureCase.id);
  }
});

test('parse fixtures produce stable parsed JSON snapshots', async () => {
  const fixtureCases = await loadIngestionFixtureCases();

  for (const fixtureCase of fixtureCases) {
    const parsed = validateParsedDocument(await parseRawFixture(fixtureCase));
    const actual = `${JSON.stringify(parsed, null, 2)}\n`;
    const expected = await readFile(join(repoRoot, fixtureCase.snapshotPath), 'utf8');

    assert.equal(actual, expected, fixtureCase.id);
  }
});

test('gmail fixture keeps quoted messages out of primary document body', async () => {
  const fixtureCases = await loadIngestionFixtureCases();
  const gmailCase = fixtureCases.find((fixtureCase) => fixtureCase.id === 'gmail-thread-alpha');

  assert.ok(gmailCase);
  const parsed = await parseRawFixture(gmailCase);

  assert.equal(parsed.docType, 'email');
  assert.equal(parsed.emailQuotes?.length, 1);
  assert.doesNotMatch(parsed.bodyText, /Please keep quoted text/);
});
