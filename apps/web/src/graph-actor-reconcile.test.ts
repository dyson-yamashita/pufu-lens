import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { mergeActorGraphElements, parseActorGraphCountRows } from './graph-actor-reconcile.ts';

assert.equal(parseActorGraphCountRows([{ value: 1 }], 'sample count'), 1);
assert.equal(parseActorGraphCountRows([{ value: '2' }], 'sample count'), 2);
assert.equal(parseActorGraphCountRows([{ value: 3n }], 'sample count'), 3);
assert.throws(
  () => parseActorGraphCountRows([], 'sample count'),
  /Invalid AGE sample count: expected 1 row, received 0/,
);
assert.throws(
  () => parseActorGraphCountRows([{ value: '1.5' }], 'sample count'),
  /Invalid AGE sample count: value is not a safe integer/,
);

const sampleReconcileInput = {
  primaryActorId: 'actor:primary-db-id',
  primaryGraphNodeId: 'actor:primary-graph-node',
  secondaryGraphNodeId: 'actor:secondary',
} as const;

assert.deepEqual(
  await mergeActorGraphElements(createTransactionMock([]).tx, {
    ...sampleReconcileInput,
    graphName: null,
  }),
  { reason: 'project graph is not configured', status: 'skipped' },
);

assert.deepEqual(
  await mergeActorGraphElements(createTransactionMock([]).tx, {
    graphName: 'graph_sample',
    primaryActorId: 'actor:same',
    primaryGraphNodeId: 'actor:same',
    secondaryGraphNodeId: 'actor:same',
  }),
  { reason: 'primary and secondary graph nodes are identical', status: 'skipped' },
);

const secondaryAbsentMock = createTransactionMock([[{ value: 0 }]]);
assert.deepEqual(
  await mergeActorGraphElements(secondaryAbsentMock.tx, {
    ...sampleReconcileInput,
    graphName: 'graph_sample',
  }),
  { reason: 'secondary actor graph node not found', status: 'skipped' },
);
assert.equal(secondaryAbsentMock.unsafeQueries.length, 1);

await assert.rejects(
  () =>
    mergeActorGraphElements(createTransactionMock([[{ value: 1 }], [{ value: 0 }]]).tx, {
      ...sampleReconcileInput,
      graphName: 'graph_sample',
    }),
  /expected 1 primary actor graph node, found 0/,
);

await assert.rejects(
  () =>
    mergeActorGraphElements(createTransactionMock([[{ value: 2 }]]).tx, {
      ...sampleReconcileInput,
      graphName: 'graph_sample',
    }),
  /expected 1 secondary actor graph node, found 2/,
);

await assert.rejects(
  () =>
    mergeActorGraphElements(createTransactionMock([[{ value: 1 }], [{ value: 2 }]]).tx, {
      ...sampleReconcileInput,
      graphName: 'graph_sample',
    }),
  /expected 1 primary actor graph node, found 2/,
);

const successfulMock = createTransactionMock([
  [{ value: 1 }],
  [{ value: 1 }],
  ...Array.from({ length: 16 }, () => []),
  [{ value: 1 }],
]);
assert.deepEqual(
  await mergeActorGraphElements(successfulMock.tx, {
    ...sampleReconcileInput,
    graphName: 'graph_sample',
  }),
  { deletedCount: 1, status: 'merged' },
);
assert.equal(successfulMock.unsafeQueries.length, 19);
assert.ok(successfulMock.unsafeQueries.every((query) => query.sql.includes('$1::agtype')));
assert.ok(successfulMock.unsafeQueries.every((query) => !query.sql.includes('jsonb::agtype')));
assert.ok(
  successfulMock.unsafeQueries.some((query) => query.sql.includes('OPTIONAL MATCH (primary)-')),
);
assert.ok(
  successfulMock.unsafeQueries.some((query) => query.sql.includes('OPTIONAL MATCH (source)-')),
);
assert.ok(
  successfulMock.unsafeQueries.some((query) =>
    query.sql.includes('CREATE (primary)-[merged:AUTHORED]->(target)'),
  ),
);
assert.ok(
  successfulMock.unsafeQueries.some((query) =>
    query.sql.includes('CREATE (source)-[merged:AUTHORED]->(primary)'),
  ),
);
assert.ok(successfulMock.unsafeQueries.every((query) => !query.sql.includes('ON CREATE SET')));
assert.ok(successfulMock.unsafeQueries.every((query) => !query.sql.includes('ON MATCH')));
assert.ok(successfulMock.unsafeQueries.every((query) => !query.sql.includes('MERGE (primary)-')));
assert.ok(successfulMock.unsafeQueries.every((query) => !query.sql.includes('MERGE (source)-')));
assert.ok(
  successfulMock.unsafeQueries
    .filter(
      (query) => query.sql.includes('CREATE (primary)-') || query.sql.includes('CREATE (source)-'),
    )
    .every((query) =>
      query.sql.includes('SET merged += properties(relation), merged.actorId = $primaryActorId'),
    ),
);
assert.ok(
  successfulMock.unsafeQueries
    .at(-1)
    ?.sql.includes('WITH secondary, count(secondary) AS deletedCount DETACH DELETE secondary'),
);
assert.ok(
  successfulMock.unsafeQueries
    .filter((query) => query.params && query.sql.includes('$secondaryGraphNodeId'))
    .every((query) => {
      const params = query.params;
      if (!params?.[0] || typeof params[0] !== 'string') {
        return false;
      }
      const parsed = JSON.parse(params[0]) as Record<string, unknown>;
      return (
        parsed.primaryActorId === sampleReconcileInput.primaryActorId &&
        parsed.primaryGraphNodeId === sampleReconcileInput.primaryGraphNodeId &&
        parsed.secondaryGraphNodeId === sampleReconcileInput.secondaryGraphNodeId &&
        !('graphName' in parsed)
      );
    }),
);

await assert.rejects(
  () =>
    mergeActorGraphElements(
      createTransactionMock([
        [{ value: 1 }],
        [{ value: 1 }],
        ...Array.from({ length: 16 }, () => []),
        [{ value: 0 }],
      ]).tx,
      {
        ...sampleReconcileInput,
        graphName: 'graph_sample',
      },
    ),
  /Actor graph reconcile failed: expected to delete 1 secondary node, deleted 0/,
);

await assert.rejects(
  () =>
    mergeActorGraphElements(createThrowingTransactionMock().tx, {
      ...sampleReconcileInput,
      graphName: 'graph_sample',
    }),
  /synthetic AGE failure/,
);

console.log('web graph actor reconcile tests passed');

function createTransactionMock(rowsByUnsafeCall: readonly (readonly unknown[])[]) {
  const pendingRows = [...rowsByUnsafeCall];
  const unsafeQueries: Array<{ params: readonly unknown[] | undefined; sql: string }> = [];
  const transaction = Object.assign(
    async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
      const query = String.raw({ raw: strings }, ...values);
      if (query.includes("LOAD 'age'") || query.includes('SET LOCAL search_path')) {
        return [];
      }
      return [];
    },
    {
      unsafe: async (sql: string, params?: readonly unknown[]) => {
        unsafeQueries.push({ params, sql });
        const rows = pendingRows.shift();
        if (!rows) {
          throw new Error('Unexpected unsafe query.');
        }
        return rows;
      },
    },
  );
  return { tx: transaction as unknown as postgres.TransactionSql, unsafeQueries };
}

function createThrowingTransactionMock() {
  const transaction = Object.assign(
    async () => {
      throw new Error('synthetic AGE failure');
    },
    {
      unsafe: async () => {
        throw new Error('synthetic AGE failure');
      },
    },
  );
  return { tx: transaction as unknown as postgres.TransactionSql };
}
