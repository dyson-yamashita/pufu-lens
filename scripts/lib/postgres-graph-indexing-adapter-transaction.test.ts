import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type postgres from 'postgres';
import type { ObjectInfo, ObjectStorage } from '../../packages/storage/dist/object-storage.js';
import { createPostgresGraphRebuildIndexingRepository } from './postgres-graph-indexing-adapter.ts';

test('createPostgresGraphRebuildIndexingRepository accepts TransactionSql executors', async () => {
  const calls: string[] = [];
  const transaction = createMockTransaction(calls);
  const storage = createMockStorage(calls);
  const repository = createPostgresGraphRebuildIndexingRepository(transaction, storage);
  const targets = await repository.readGraphTargets({
    limit: 1,
    projectId: '00000000-0000-0000-0000-000000000001',
    resumeCursor: 'a'.repeat(64),
  });
  assert.equal(targets.length, 0);
  assert.equal(
    calls.some((entry) => entry.startsWith('sql:')),
    true,
  );
  assert.equal('begin' in transaction, false);
});

test('withIndexingTransaction helper is used for status mutations', async () => {
  const adapterSource = await readFile(
    new URL('./postgres-graph-indexing-adapter.ts', import.meta.url),
    'utf8',
  );
  assert.match(adapterSource, /async function withIndexingTransaction</);
  assert.match(adapterSource, /await withIndexingTransaction\(this\.sql, async \(transaction\)/);
  assert.doesNotMatch(adapterSource, /requireSqlExecutor/);
});

function createMockStorage(calls: string[]): ObjectStorage {
  return {
    async exists(): Promise<boolean> {
      return false;
    },
    async get(): Promise<NodeJS.ReadableStream> {
      throw new Error('Not implemented.');
    },
    async getText(uri: string): Promise<string> {
      calls.push(`getText:${uri}`);
      return '{}';
    },
    async *list(_prefix: string): AsyncIterable<ObjectInfo> {},
    async put(): Promise<{ uri: string }> {
      throw new Error('Not implemented.');
    },
  };
}

function createMockTransaction(calls: string[]): postgres.TransactionSql {
  const transaction = (async (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<readonly unknown[]> => {
    calls.push(`sql:${strings.join('?')}:${values.length}`);
    return [];
  }) as postgres.TransactionSql;
  return transaction;
}
