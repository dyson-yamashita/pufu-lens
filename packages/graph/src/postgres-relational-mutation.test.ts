import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
import {
  canonicalizeSameAsEdgeEndpoints,
  createPostgresRelationalGraphMutationRepository,
  deriveRelationalGraphNodeKindSubtype,
  parseRelationalGraphMutationCountRow,
} from './postgres-relational-mutation.js';

test('relational graph mutation adapter exposes project-scoped mutation methods', () => {
  const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
  const repository = createPostgresRelationalGraphMutationRepository(sql);
  assert.equal(typeof repository.ensureProjectGraph, 'function');
  assert.equal(typeof repository.deleteProjectGraph, 'function');
  assert.equal(typeof repository.upsertNode, 'function');
  assert.equal(typeof repository.upsertEdge, 'function');
  assert.equal(typeof repository.mergeActorGraphNodes, 'function');
  assert.equal(typeof repository.deleteDocumentGraphNodes, 'function');
});

test('canonicalizeSameAsEdgeEndpoints stores lexicographic endpoint pairs', () => {
  assert.deepEqual(
    canonicalizeSameAsEdgeEndpoints('document:issue-714-b', 'document:issue-714-a'),
    {
      sourceNodeKey: 'document:issue-714-a',
      targetNodeKey: 'document:issue-714-b',
    },
  );
  assert.deepEqual(
    canonicalizeSameAsEdgeEndpoints('document:issue-714-a', 'document:issue-714-b'),
    {
      sourceNodeKey: 'document:issue-714-a',
      targetNodeKey: 'document:issue-714-b',
    },
  );
  assert.throws(
    () => canonicalizeSameAsEdgeEndpoints('document:issue-714-a', 'document:issue-714-a'),
    /SAME_AS endpoints must differ/,
  );
});

test('deriveRelationalGraphNodeKindSubtype normalizes Document Actor and Topic labels', () => {
  assert.deepEqual(
    deriveRelationalGraphNodeKindSubtype({
      labels: ['Document'],
      properties: {
        docType: 'email',
        documentId: '71400000-0000-0000-0000-000000000002',
        graphLabels: ['Document'],
        graphNodeId: 'document:issue-714-related',
      },
    }),
    {
      kind: 'document',
      normalizedProperties: {
        docType: 'email',
        documentId: '71400000-0000-0000-0000-000000000002',
        graphLabels: ['Document'],
        graphNodeId: 'document:issue-714-related',
      },
      subtype: 'email',
    },
  );
  assert.deepEqual(
    deriveRelationalGraphNodeKindSubtype({
      labels: ['Topic'],
      properties: {
        graphLabels: ['Topic'],
        graphNodeId: 'topic:issue-714-shared',
        topicType: 'keyword',
      },
    }),
    {
      kind: 'topic',
      normalizedProperties: {
        graphLabels: ['Topic'],
        graphNodeId: 'topic:issue-714-shared',
        topicType: 'keyword',
      },
      subtype: 'keyword',
    },
  );
});

test('parseRelationalGraphMutationCountRow rejects malformed provider rows', () => {
  assert.equal(parseRelationalGraphMutationCountRow({ count: 2 }, 'deleted count'), 2);
  assert.equal(parseRelationalGraphMutationCountRow({ count: '3' }, 'deleted count'), 3);
  assert.throws(
    () => parseRelationalGraphMutationCountRow({ count: '1.5' }, 'deleted count'),
    /safe integer/,
  );
  assert.throws(
    () => parseRelationalGraphMutationCountRow({ count: null }, 'deleted count'),
    /Invalid relational deleted count/,
  );
});

test('relational graph mutation adapter rejects empty projectId for lifecycle mutations', async () => {
  const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
  const repository = createPostgresRelationalGraphMutationRepository(sql);
  await assert.rejects(
    () => repository.ensureProjectGraph({ projectId: '' }),
    /Invalid graph field: projectId/,
  );
  await assert.rejects(
    () => repository.deleteProjectGraph({ projectId: ' ' }),
    /Invalid graph field: projectId/,
  );
});

test('relational graph mutation adapter accepts postgres.TransactionSql bindings', () => {
  const transaction = (() => Promise.resolve([])) as unknown as postgres.TransactionSql;
  const repository = createPostgresRelationalGraphMutationRepository(transaction);
  assert.equal(typeof repository.mergeActorGraphNodes, 'function');
});

test('ensureProjectGraph rejects malformed project lookup rows as mutation unavailable', async () => {
  const projectId = '71400000-0000-0000-0000-000000000001';
  const mismatchSql = Object.assign(
    () => Promise.resolve([{ id: '71400000-0000-0000-0000-000000000002' }]),
    {
      begin: async (callback: (value: unknown) => unknown) => callback([]),
    },
  ) as unknown as postgres.Sql;
  await assert.rejects(
    () =>
      createPostgresRelationalGraphMutationRepository(mismatchSql).ensureProjectGraph({
        projectId,
      }),
    /Graph mutation capability unavailable/,
  );

  const malformedSql = Object.assign(() => Promise.resolve([{ id: 123 }]), {
    begin: async (callback: (value: unknown) => unknown) => callback([]),
  }) as unknown as postgres.Sql;
  await assert.rejects(
    () =>
      createPostgresRelationalGraphMutationRepository(malformedSql).ensureProjectGraph({
        projectId,
      }),
    /Graph mutation capability unavailable/,
  );
});

test('ensureProjectGraph succeeds when project lookup row matches requested projectId', async () => {
  const projectId = '71400000-0000-0000-0000-000000000001';
  const sql = Object.assign(() => Promise.resolve([{ id: projectId }]), {
    begin: async (callback: (value: unknown) => unknown) => callback([]),
  }) as unknown as postgres.Sql;
  await createPostgresRelationalGraphMutationRepository(sql).ensureProjectGraph({ projectId });
});
