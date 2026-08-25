import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const adapterSource = await readFile(
  new URL('./postgres-graph-indexing-adapter.ts', import.meta.url),
  'utf8',
);

const GRAPH_REBUILD_RESUME_CURSOR_DIGEST_SQL =
  "encode(sha256(convert_to(rd.id::text, 'UTF8')), 'hex')";

function sliceAdapterFunction(startMarker: string, endMarker: string): string {
  const startIndex = adapterSource.indexOf(startMarker);
  assert.notEqual(startIndex, -1, `${startMarker} should exist`);
  const endIndex = adapterSource.indexOf(endMarker, startIndex);
  assert.notEqual(endIndex, -1, `${endMarker} should exist`);
  return adapterSource.slice(startIndex, endIndex);
}

test('postgres graph rebuild indexing adapter scopes selection to current parsed documents', () => {
  const methodSource = sliceAdapterFunction(
    'private async readRebuildGraphTargetRows',
    'function parseProjectResolverRow',
  );

  assert.match(methodSource, /d\.project_id = \$\{input\.projectId\}/);
  assert.match(methodSource, /rd\.project_id = \$\{input\.projectId\}/);
  assert.match(methodSource, /rd\.parsed_uri IS NOT NULL/);
  assert.match(methodSource, /rd\.ingest_status IN \('parsed', 'indexed'\)/);
  assert.match(methodSource, /LIMIT \$\{input\.limit\}/);
  assert.doesNotMatch(methodSource, /cypher\(/);
  assert.doesNotMatch(methodSource, /ingest_status DESC/);
});

test('postgres graph rebuild indexing adapter uses digest cursor ordering', () => {
  const methodSource = sliceAdapterFunction(
    'private async readRebuildGraphTargetRows',
    'function parseProjectResolverRow',
  );

  assert.match(
    methodSource,
    new RegExp(GRAPH_REBUILD_RESUME_CURSOR_DIGEST_SQL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.match(methodSource, /> \$\{input\.resumeCursor/);
  assert.match(
    methodSource,
    /ORDER BY encode\(sha256\(convert_to\(rd\.id::text, 'UTF8'\)\), 'hex'\), rd\.id/,
  );
});

test('createPostgresGraphRebuildIndexingRepository is exported separately from incremental factory', () => {
  assert.match(adapterSource, /export function createPostgresGraphRebuildIndexingRepository/);
  assert.match(adapterSource, /PostgresGraphExecutor/);
});
