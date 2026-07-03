import assert from 'node:assert/strict';
import type postgres from 'postgres';
import {
  mergeActorGraphElements,
  parseActorGraphCountRows,
  reconcileMergedActorGraphElements,
} from './graph-actor-reconcile.ts';

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
  await mergeActorGraphElements(createSqlMock([]).sql, {
    ...sampleReconcileInput,
    graphName: null,
  }),
  { reason: 'project graph is not configured', status: 'skipped' },
);

assert.deepEqual(
  await mergeActorGraphElements(createSqlMock([]).sql, {
    graphName: 'graph_sample',
    primaryActorId: 'actor:same',
    primaryGraphNodeId: 'actor:same',
    secondaryGraphNodeId: 'actor:same',
  }),
  { reason: 'primary and secondary graph nodes are identical', status: 'skipped' },
);

assert.deepEqual(
  await mergeActorGraphElements(createSqlMock([[{ value: 0 }]]).sql, {
    ...sampleReconcileInput,
    graphName: 'graph_sample',
  }),
  { reason: 'expected 1 primary actor graph node, found 0', status: 'skipped' },
);

assert.deepEqual(
  await mergeActorGraphElements(createSqlMock([[{ value: 1 }], [{ value: 0 }]]).sql, {
    ...sampleReconcileInput,
    graphName: 'graph_sample',
  }),
  { reason: 'secondary actor graph node not found', status: 'skipped' },
);

const successfulMock = createSqlMock([
  [{ value: 1 }],
  [{ value: 1 }],
  ...Array.from({ length: 16 }, () => [{ value: 0 }]),
  [{ value: 1 }],
]);
assert.deepEqual(
  await mergeActorGraphElements(successfulMock.sql, {
    ...sampleReconcileInput,
    graphName: 'graph_sample',
  }),
  { deletedCount: 1, status: 'merged' },
);
assert.equal(successfulMock.unsafeQueries.length, 19);
assert.ok(successfulMock.unsafeQueries.every((query) => query.sql.includes('$1::agtype')));
assert.ok(successfulMock.unsafeQueries.every((query) => !query.sql.includes('jsonb::agtype')));
assert.ok(successfulMock.unsafeQueries.some((query) => query.sql.includes('MERGE (primary)-')));
assert.ok(successfulMock.unsafeQueries.some((query) => query.sql.includes('MERGE (source)-')));
assert.ok(successfulMock.unsafeQueries.every((query) => !query.sql.includes('CREATE (primary)-')));
assert.ok(successfulMock.unsafeQueries.every((query) => !query.sql.includes('CREATE (source)-')));
assert.ok(
  successfulMock.unsafeQueries
    .filter(
      (query) => query.sql.includes('MERGE (primary)-') || query.sql.includes('MERGE (source)-'),
    )
    .every((query) =>
      query.sql.includes(
        'ON CREATE SET merged += properties(relation), merged.actorId = $primaryActorId',
      ),
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
      createSqlMock([
        [{ value: 1 }],
        [{ value: 1 }],
        ...Array.from({ length: 16 }, () => [{ value: 0 }]),
        [{ value: 0 }],
      ]).sql,
      {
        ...sampleReconcileInput,
        graphName: 'graph_sample',
      },
    ),
  /Actor graph reconcile failed: expected to delete 1 secondary node, deleted 0/,
);

const originalWarn = console.warn;
const warnings: string[] = [];
console.warn = (message?: unknown): void => {
  warnings.push(String(message));
};
try {
  await reconcileMergedActorGraphElements(createSqlMock([[{ value: 2 }]]).sql, {
    ...sampleReconcileInput,
    graphName: 'graph_sample',
  });
  assert.match(warnings.at(-1) ?? '', /expected 1 primary actor graph node, found 2/);
  assert.match(
    warnings.at(-1) ?? '',
    /graph=graph_sample, primary=actor:primary-graph-node, secondary=actor:secondary/,
  );

  warnings.length = 0;
  await reconcileMergedActorGraphElements(createThrowingSqlMock().sql, {
    ...sampleReconcileInput,
    graphName: 'graph_sample',
  });
  assert.match(
    warnings.at(-1) ?? '',
    /AGE actor graph reconcile failed \(graph=graph_sample, primary=actor:primary-graph-node, secondary=actor:secondary\): synthetic AGE failure/,
  );
} finally {
  console.warn = originalWarn;
}

console.log('web graph actor reconcile tests passed');

function createSqlMock(rowsByUnsafeCall: readonly (readonly unknown[])[]) {
  const pendingRows = [...rowsByUnsafeCall];
  const unsafeQueries: Array<{ params: readonly unknown[] | undefined; sql: string }> = [];
  const transaction = Object.assign(async () => [], {
    unsafe: async (sql: string, params?: readonly unknown[]) => {
      unsafeQueries.push({ params, sql });
      const rows = pendingRows.shift();
      if (!rows) {
        throw new Error('Unexpected unsafe query.');
      }
      return rows;
    },
  });
  const sql = {
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(transaction as unknown as postgres.TransactionSql),
  };
  return { sql: sql as unknown as postgres.Sql, unsafeQueries };
}

function createThrowingSqlMock() {
  const sql = {
    begin: async () => {
      throw new Error('synthetic AGE failure');
    },
  };
  return { sql: sql as unknown as postgres.Sql };
}
