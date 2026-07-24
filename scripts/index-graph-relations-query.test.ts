import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./index-graph-relations.ts', import.meta.url), 'utf8');

test('readGraphTargetRows exposes raw ingest status for graph re-index selection', () => {
  const match = source.match(
    /private async readGraphTargetRows[\s\S]*?`([\s\S]*?)`\s*\) as GraphTargetRow\[\]/,
  );
  assert.ok(match, 'readGraphTargetRows SQL query should exist');
  const query = match[1] ?? '';

  assert.match(query, /rd\.ingest_status AS "ingestStatus"/);
  assert.match(query, /rd\.ingest_status IN \('parsed', 'indexed'\)/);
  assert.match(query, /ORDER BY\s+rd\.ingest_status DESC/);
});

test('readGraphTargets uses parsed-aware graph index target selection', () => {
  assert.match(source, /selectGraphIndexTargets\(/);
  assert.doesNotMatch(source, /selectMissingGraphTargets\(/);
});
