import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { mergeActorGraphElements, parseActorGraphCountRows } from './graph-actor-merge.ts';

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

await assert.rejects(
  () =>
    mergeActorGraphElements(createTransactionSqlMock([[{ value: 0 }]]), {
      graphName: 'graph_sample',
      primaryGraphNodeId: 'actor:primary',
      secondaryGraphNodeId: 'actor:secondary',
    }),
  /Actor graph merge failed: expected 1 primary node, found 0/,
);
await assert.rejects(
  () =>
    mergeActorGraphElements(createTransactionSqlMock([[{ value: 1 }], [{ value: 2 }]]), {
      graphName: 'graph_sample',
      primaryGraphNodeId: 'actor:primary',
      secondaryGraphNodeId: 'actor:secondary',
    }),
  /Actor graph merge failed: expected 1 secondary node, found 2/,
);
await assert.rejects(
  () =>
    mergeActorGraphElements(
      createTransactionSqlMock([
        [{ value: 1 }],
        [{ value: 1 }],
        ...Array.from({ length: 16 }, () => [{ value: 0 }]),
        [{ value: 0 }],
      ]),
      {
        graphName: 'graph_sample',
        primaryGraphNodeId: 'actor:primary',
        secondaryGraphNodeId: 'actor:secondary',
      },
    ),
  /Actor graph merge failed: expected to delete 1 secondary node, deleted 0/,
);

console.log('web graph actor merge tests passed');

function createTransactionSqlMock(rowsByUnsafeCall: readonly (readonly unknown[])[]) {
  const pendingRows = [...rowsByUnsafeCall];
  const sql = Object.assign(async () => [], {
    unsafe: async () => {
      const rows = pendingRows.shift();
      if (!rows) {
        throw new Error('Unexpected unsafe query.');
      }
      return rows;
    },
  });
  return sql as unknown as postgres.TransactionSql;
}
