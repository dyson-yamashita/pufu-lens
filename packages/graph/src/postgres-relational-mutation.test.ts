import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
import {
  GraphMutationUnavailableError,
  isMutationUnavailableError,
} from './postgres-relational-common.js';
import {
  canonicalizeSameAsEdgeEndpoints,
  createPostgresRelationalGraphMutationRepository,
  deriveRelationalGraphNodeKindSubtype,
  parseRelationalGraphMutationCountRow,
} from './postgres-relational-mutation.js';

const PROJECT_ID = '71400000-0000-0000-0000-000000000001';
const PRIMARY_NODE = 'actor:issue-714-primary';
const SECONDARY_NODE = 'actor:issue-714-secondary';
const PRIMARY_ACTOR_ID = '71400000-0000-0000-0000-000000000020';

function createOwnedSqlMock(
  transactionBehavior: (transaction: postgres.TransactionSql) => unknown,
): { readonly sql: postgres.Sql; tagCalls: () => number } {
  let tagCalls = 0;
  const transaction = ((
    strings: TemplateStringsArray | readonly string[],
    ...values: readonly unknown[]
  ) => {
    tagCalls += 1;
    void strings;
    void values;
    return transactionBehavior(transaction as postgres.TransactionSql);
  }) as unknown as postgres.TransactionSql;
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
      tagCalls += 1;
      void strings;
      void values;
      return Promise.resolve([]);
    },
    {
      begin: async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
        callback(transaction),
    },
  ) as unknown as postgres.Sql;
  return { sql, tagCalls: () => tagCalls };
}

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

test('canonicalizeSameAsEdgeEndpoints uses UTF-8 byte order instead of UTF-16 code unit order', () => {
  const bmpPeer = `actor:issue-714-merge-${'\uE000'}`;
  const nonBmpPeer = `actor:issue-714-merge-${'\u{10000}'}`;
  assert.notEqual(
    bmpPeer <= nonBmpPeer,
    Buffer.from(bmpPeer, 'utf8').compare(Buffer.from(nonBmpPeer, 'utf8')) <= 0,
  );
  assert.deepEqual(canonicalizeSameAsEdgeEndpoints(nonBmpPeer, bmpPeer), {
    sourceNodeKey: bmpPeer,
    targetNodeKey: nonBmpPeer,
  });
  assert.deepEqual(canonicalizeSameAsEdgeEndpoints(bmpPeer, nonBmpPeer), {
    sourceNodeKey: bmpPeer,
    targetNodeKey: nonBmpPeer,
  });
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
    (error: unknown) => isMutationUnavailableError(error),
  );

  const malformedSql = Object.assign(() => Promise.resolve([{ id: 123 }]), {
    begin: async (callback: (value: unknown) => unknown) => callback([]),
  }) as unknown as postgres.Sql;
  await assert.rejects(
    () =>
      createPostgresRelationalGraphMutationRepository(malformedSql).ensureProjectGraph({
        projectId,
      }),
    (error: unknown) => isMutationUnavailableError(error),
  );
});

test('ensureProjectGraph succeeds when project lookup row matches requested projectId', async () => {
  const projectId = '71400000-0000-0000-0000-000000000001';
  const sql = Object.assign(() => Promise.resolve([{ id: projectId }]), {
    begin: async (callback: (value: unknown) => unknown) => callback([]),
  }) as unknown as postgres.Sql;
  await createPostgresRelationalGraphMutationRepository(sql).ensureProjectGraph({ projectId });
});

test('deleteDocumentGraphNodes rejects database failures as mutation unavailable', async () => {
  const dbError = new Error('relational delete failed');
  const sql = ((first: TemplateStringsArray | readonly string[], ...values: readonly unknown[]) => {
    const template = first as unknown as TemplateStringsArray;
    if (Array.isArray(first) && Array.isArray(template.raw)) {
      void values;
      return Promise.reject(dbError);
    }
    return first;
  }) as unknown as postgres.Sql;
  await assert.rejects(
    () =>
      createPostgresRelationalGraphMutationRepository(sql).deleteDocumentGraphNodes({
        graphNodeIds: ['document:issue-714-seed'],
        projectId: PROJECT_ID,
      }),
    (error: unknown) => isMutationUnavailableError(error),
  );
});

test('mergeActorGraphNodes skips identical primary and secondary graph nodes', async () => {
  const { sql } = createOwnedSqlMock(() => Promise.resolve([]));
  const result = await createPostgresRelationalGraphMutationRepository(sql).mergeActorGraphNodes({
    primaryActorId: PRIMARY_ACTOR_ID,
    primaryGraphNodeId: PRIMARY_NODE,
    projectId: PROJECT_ID,
    secondaryGraphNodeId: PRIMARY_NODE,
  });
  assert.deepEqual(result, {
    reason: 'primary and secondary graph nodes are identical',
    status: 'skipped',
  });
});

test('mergeActorGraphNodes skips when secondary actor graph node is missing', async () => {
  const { sql } = createOwnedSqlMock(() => Promise.resolve([{ count: 0 }]));
  const result = await createPostgresRelationalGraphMutationRepository(sql).mergeActorGraphNodes({
    primaryActorId: PRIMARY_ACTOR_ID,
    primaryGraphNodeId: PRIMARY_NODE,
    projectId: PROJECT_ID,
    secondaryGraphNodeId: 'actor:issue-714-missing',
  });
  assert.deepEqual(result, {
    reason: 'secondary actor graph node not found',
    status: 'skipped',
  });
});

test('upsertEdge rejects SAME_AS edges with identical endpoints', async () => {
  const { sql } = createOwnedSqlMock(() => Promise.resolve([]));
  await assert.rejects(
    () =>
      createPostgresRelationalGraphMutationRepository(sql).upsertEdge({
        fromGraphNodeId: 'document:issue-714-a',
        projectId: PROJECT_ID,
        properties: {},
        relationType: 'SAME_AS',
        toGraphNodeId: 'document:issue-714-a',
      }),
    /SAME_AS endpoints must differ/,
  );
});

test('owned Sql mergeActorGraphNodes normalizes database failures to unavailable', async () => {
  const dbError = new Error('owned merge transaction failed');
  const { sql } = createOwnedSqlMock(() => Promise.reject(dbError));
  const result = await createPostgresRelationalGraphMutationRepository(sql).mergeActorGraphNodes({
    primaryActorId: PRIMARY_ACTOR_ID,
    primaryGraphNodeId: PRIMARY_NODE,
    projectId: PROJECT_ID,
    secondaryGraphNodeId: SECONDARY_NODE,
  });
  assert.deepEqual(result, { status: 'unavailable' });
});

test('injected TransactionSql mergeActorGraphNodes rethrows database failures', async () => {
  const dbError = new Error('injected merge transaction failed');
  const transaction = ((
    strings: TemplateStringsArray | readonly string[],
    ...values: readonly unknown[]
  ) => {
    void strings;
    void values;
    return Promise.reject(dbError);
  }) as unknown as postgres.TransactionSql;
  await assert.rejects(
    () =>
      createPostgresRelationalGraphMutationRepository(transaction).mergeActorGraphNodes({
        primaryActorId: PRIMARY_ACTOR_ID,
        primaryGraphNodeId: PRIMARY_NODE,
        projectId: PROJECT_ID,
        secondaryGraphNodeId: SECONDARY_NODE,
      }),
    (error: unknown) => error === dbError,
  );
});

test('createMutationUnavailableError is identified by mutation unavailable predicate', () => {
  const error = new GraphMutationUnavailableError();
  assert.ok(isMutationUnavailableError(error));
  assert.ok(!isMutationUnavailableError(new Error('other failure')));
});
