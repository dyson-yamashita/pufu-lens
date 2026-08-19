import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
import {
  ageGraphPresetPreview,
  createPostgresAgeGraphReadRepository,
  graphRelationQueryRowLimit,
  normalizeAgeGraphRows,
  selectGraphRelatedDocumentCandidates,
} from './postgres-graph-read-adapter.ts';

test('AGE graph read adapter exposes project-scoped capability methods', () => {
  const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
  const repository = createPostgresAgeGraphReadRepository(sql);
  assert.equal(typeof repository.findRelatedDocuments, 'function');
  assert.equal(typeof repository.readPreset, 'function');
  assert.equal(typeof repository.countDocumentNode, 'function');
  assert.equal(typeof repository.countRelations, 'function');
});

test('AGE graph read adapter normalizes missing project graph to unavailable', async () => {
  const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
  const repository = createPostgresAgeGraphReadRepository(sql);
  assert.deepEqual(
    await repository.findRelatedDocuments({
      projectId: '11111111-1111-4111-8111-111111111111',
      seedDocumentIds: ['document-a'],
    }),
    { candidates: [], status: 'unavailable' },
  );
});

test('AGE graph read adapter returns an empty success without touching the provider', async () => {
  const sql = (() => {
    assert.fail('provider query should not run without seed documents');
  }) as unknown as postgres.Sql;
  const repository = createPostgresAgeGraphReadRepository(sql);
  assert.deepEqual(
    await repository.findRelatedDocuments({ projectId: 'project-a', seedDocumentIds: [] }),
    { candidates: [], status: 'success' },
  );
});

test('AGE graph read adapter logs provider unavailability without sensitive identifiers', async () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => messages.push(String(message));
  try {
    const sql = (() =>
      Promise.reject(new Error('postgresql://secret-host/private'))) as unknown as postgres.Sql;
    const repository = createPostgresAgeGraphReadRepository(sql);
    assert.deepEqual(
      await repository.findRelatedDocuments({
        projectId: '11111111-1111-4111-8111-111111111111',
        seedDocumentIds: ['sensitive-document-id'],
      }),
      { candidates: [], status: 'unavailable' },
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? '', /graph_read_unavailable/);
  assert.doesNotMatch(messages[0] ?? '', /secret-host|sensitive-document-id|11111111/);
});

test('AGE graph read adapter binds project and seed identifiers through the AGE parameter map', async () => {
  const unsafeCalls: Array<{ parameters?: readonly unknown[]; query: string }> = [];
  const transaction = Object.assign(() => Promise.resolve([]), {
    unsafe(query: string, parameters?: readonly unknown[]) {
      unsafeCalls.push({ parameters, query });
      return Promise.resolve([]);
    },
  });
  const sql = Object.assign(
    () => Promise.resolve([{ graphName: 'graph_11111111_1111_4111_8111_111111111111' }]),
    { begin: (callback: (value: unknown) => unknown) => callback(transaction) },
  ) as unknown as postgres.Sql;
  const repository = createPostgresAgeGraphReadRepository(sql);
  assert.deepEqual(
    await repository.findRelatedDocuments({
      projectId: '11111111-1111-4111-8111-111111111111',
      seedDocumentIds: ['document-with-newline\nvalue'],
    }),
    { candidates: [], status: 'success' },
  );
  assert.equal(unsafeCalls.length, 3);
  for (const call of unsafeCalls) {
    assert.match(call.query, /\$projectId/);
    assert.match(call.query, /\$seedDocumentIds/);
    assert.doesNotMatch(call.query, /document-with-newline/);
    assert.deepEqual(JSON.parse(String(call.parameters?.[0])), {
      projectId: '11111111-1111-4111-8111-111111111111',
      seedDocumentIds: ['document-with-newline\nvalue'],
    });
  }
});

test('normalizeAgeGraphRows skips malformed typed values and reports truncation', () => {
  const vertex = (id: number) =>
    `${JSON.stringify({ id, label: 'Document', properties: { title: `Document ${id}` } })}::vertex`;
  assert.deepEqual(
    normalizeAgeGraphRows([{ malformed: '{}::vertex', valid: vertex(1) }], {
      maxEdges: 1,
      maxNodes: 5,
    }).nodes.map((node) => node.id),
    ['1'],
  );
  assert.equal(
    normalizeAgeGraphRows([{ first: vertex(1), second: vertex(2) }], {
      maxEdges: 1,
      maxNodes: 1,
    }).truncated,
    true,
  );
});

test('graph relation helpers preserve bounds, dedupe, and preset limits', () => {
  assert.equal(graphRelationQueryRowLimit(100, 100), 50);
  assert.equal(graphRelationQueryRowLimit(0, 0), 1);
  const vertex = (documentId: string) =>
    `${JSON.stringify({ properties: { documentId } })}::vertex`;
  assert.deepEqual(
    selectGraphRelatedDocumentCandidates({
      relationLimits: { SAME_AS: 1 },
      relationRows: [
        {
          hopCount: 1,
          relationType: 'SAME_AS',
          rows: [
            { related: vertex('related-a'), seed: vertex('seed-a') },
            { related: vertex('related-a'), seed: vertex('seed-b') },
            { related: vertex('related-b'), seed: vertex('seed-a') },
          ],
        },
      ],
    }).map((candidate) => candidate.documentId),
    ['related-a'],
  );
  assert.match(ageGraphPresetPreview('actor-documents'), /LIMIT 500$/);
  assert.match(ageGraphPresetPreview('recent-relations'), /LIMIT 500$/);
});
