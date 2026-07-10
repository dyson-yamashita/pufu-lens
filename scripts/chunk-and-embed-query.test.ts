import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./chunk-and-embed.ts', import.meta.url), 'utf8');

test('latest raw filtering only lets processable newer versions supersede parsed work', () => {
  assert.match(
    source,
    /newer\.ingest_status IN \('parsed', 'indexed'\)[\s\S]*newer\.parsed_uri IS NOT NULL/,
  );
});

test('document version activation locks and revalidates the latest processable raw', () => {
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /lockLatestProcessableDocumentVersion/);
  assert.match(source, /target\.ingest_status IN \('parsed', 'indexed'\)/);
});
