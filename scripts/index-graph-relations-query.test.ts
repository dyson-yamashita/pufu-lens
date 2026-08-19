import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const adapterSource = await readFile(
  new URL('./lib/postgres-graph-indexing-adapter.ts', import.meta.url),
  'utf8',
);
const entrySource = await readFile(new URL('./index-graph-relations.ts', import.meta.url), 'utf8');

function sliceAdapterFunction(startMarker: string, endMarker: string): string {
  const startIndex = adapterSource.indexOf(startMarker);
  assert.notEqual(startIndex, -1, `${startMarker} should exist`);
  const endIndex = adapterSource.indexOf(endMarker, startIndex);
  assert.notEqual(endIndex, -1, `${endMarker} should exist`);
  return adapterSource.slice(startIndex, endIndex);
}

test('postgres graph indexing adapter exposes ingest-status-aware target selection SQL', () => {
  const methodSource = sliceAdapterFunction(
    'private async readGraphTargetRows',
    'async findActorByAlias',
  );

  assert.match(methodSource, /rd\.ingest_status AS "ingestStatus"/);
  assert.match(methodSource, /rd\.ingest_status IN \('parsed', 'indexed'\)/);
  assert.match(methodSource, /ORDER BY/);
  assert.match(methodSource, /rd\.ingest_status DESC/);
  assert.match(methodSource, /d\.project_id = \$\{input\.projectId\}/);
  assert.match(methodSource, /rd\.project_id = \$\{input\.projectId\}/);
});

test('postgres graph indexing adapter uses parsed-aware graph index target selection', () => {
  assert.match(adapterSource, /selectGraphIndexTargets\(/);
  assert.doesNotMatch(adapterSource, /selectMissingGraphTargets\(/);
});

test('index-graph-relations entrypoint stays a composition root', () => {
  assert.match(entrySource, /storeGraphRelations\(/);
  assert.match(entrySource, /createPostgresGraphProjectResolver\(/);
  assert.match(entrySource, /createPostgresGraphIndexingRepository\(/);
  assert.match(entrySource, /createPostgresAgeGraphMutationRepository\(/);
  assert.doesNotMatch(entrySource, /GraphRelationsRepository/);
  assert.doesNotMatch(entrySource, /graphName/);
  assert.doesNotMatch(entrySource, /cypher\(/);
  assert.doesNotMatch(entrySource, /agtype/);
  assert.doesNotMatch(entrySource, /create_graph/);
});

test('postgres graph indexing adapter validates resolved graph names through cli helper', () => {
  assert.match(adapterSource, /from ['"]\.\/cli\.ts['"]/);
  assert.match(adapterSource, /validateGraphName/);

  const resolveProjectGraphNameSource = sliceAdapterFunction(
    'async function resolveProjectGraphName',
    'async function listExistingDocumentGraphNodeIds',
  );
  assert.match(resolveProjectGraphNameSource, /graphName === null/);
  assert.match(resolveProjectGraphNameSource, /typeof graphName !== 'string'/);
  assert.match(resolveProjectGraphNameSource, /graphName\.trim\(\)/);
  assert.match(resolveProjectGraphNameSource, /return undefined/);
  assert.match(resolveProjectGraphNameSource, /return validateGraphName\s*\(\s*graphName\s*\)/);
});

test('postgres graph indexing adapter treats AGE document node rows as unknown collections', () => {
  const methodSource = sliceAdapterFunction(
    'async function listExistingDocumentGraphNodeIds',
    'async function listExistingRelatedDocumentEdgeKeys',
  );

  assert.doesNotMatch(methodSource, /as Array<\{\s*graph_node_id:/);
  assert.match(methodSource, /as unknown/);
  assert.match(methodSource, /isRecord/);
  assert.match(methodSource, /\.map\(/);
  assert.match(methodSource, /parseAgtypeString/);
});

test('postgres graph indexing adapter treats AGE related edge rows as unknown collections', () => {
  const methodSource = sliceAdapterFunction(
    'async function listExistingRelatedDocumentEdgeKeys',
    'async function ensureAgeSession',
  );

  assert.doesNotMatch(methodSource, /as Array<\{\s*from_graph_node_id:/);
  assert.match(methodSource, /as unknown/);
  assert.match(methodSource, /isRecord/);
  assert.match(methodSource, /\.map\(/);
  assert.match(methodSource, /parseAgtypeString/);
});

test('postgres graph indexing adapter bounds related document backfill parsed-text reads', () => {
  assert.match(adapterSource, /GRAPH_RELATED_PARSED_TEXT_READ_CONCURRENCY\s*=\s*10/);

  const methodSource = sliceAdapterFunction(
    'private async selectRelatedDocumentBackfillRows',
    'private async readParsedText',
  );

  assert.match(methodSource, /GRAPH_RELATED_PARSED_TEXT_READ_CONCURRENCY/);
  assert.match(methodSource, /for\s*\(/);
  assert.match(methodSource, /slice\(/);
  assert.match(methodSource, /Promise\.all\(/);
  assert.doesNotMatch(methodSource, /await Promise\.all\(\s*input\.rows/);
});
