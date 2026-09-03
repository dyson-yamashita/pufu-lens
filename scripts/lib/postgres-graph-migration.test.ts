import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
import { runGraphCompare } from './postgres-graph-migration.ts';

test('runGraphCompare uses one read-only repeatable-read transaction for all provider reads', async () => {
  const calls: string[] = [];
  const sql = createMockCompareSql(calls);
  const result = await runGraphCompare({
    limit: 10,
    projectSlug: 'issue-716-compare-contract',
    sql,
  });

  assert.equal(calls.filter((entry) => entry === 'begin').length, 1);
  assert.equal(
    calls.some((entry) =>
      entry.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'),
    ),
    true,
  );
  assert.equal(
    calls.indexOf('begin') < calls.findIndex((entry) => entry.includes('SET TRANSACTION')),
    true,
  );
  assert.equal(result.gateStatus, 'pass');
});

function createMockCompareSql(calls: string[]): postgres.Sql {
  const transaction = createMockCompareTransaction(calls);
  return {
    async begin<T>(callback: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
      calls.push('begin');
      return callback(transaction);
    },
  } as postgres.Sql;
}

function createMockCompareTransaction(calls: string[]): postgres.TransactionSql {
  const tagged = async (
    strings: TemplateStringsArray,
    ..._values: readonly unknown[]
  ): Promise<readonly unknown[]> => {
    const query = strings.join('');
    calls.push(`tx:tagged:${query}`);
    if (query.includes('FROM public.projects') && query.includes('WHERE slug')) {
      return [
        {
          projectId: '00000000-0000-0000-0000-000000000099',
          projectSlug: 'issue-716-compare-contract',
        },
      ];
    }
    if (query.includes('graph_name AS "graphName"')) {
      return [{ graphName: null }];
    }
    if (query.includes('currentDocumentMissingParsedOrStatus')) {
      return [
        {
          currentDocumentMissingParsedOrStatus: 0,
          currentLifecycleOnlyDocument: 0,
          mergedActorAliasReference: 0,
          mergedActorEmailQuoteReference: 0,
          mergedActorMissingMergeDecision: 0,
          relationalDocumentNodeWithoutDocumentRow: 0,
        },
      ];
    }
    if (query.includes('FROM public.graph_nodes')) {
      return [];
    }
    if (query.includes('FROM public.graph_edges')) {
      return [];
    }
    return [];
  };
  const transaction = Object.assign(tagged, {
    unsafe(query: string) {
      calls.push(`tx:unsafe:${query}`);
      return Promise.resolve([]);
    },
  }) as postgres.TransactionSql;
  return transaction;
}
