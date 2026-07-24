import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
import { normalizeGitHubIssueLifecycle } from '../../packages/ingestion/dist/index.js';
import type { ObjectStorage } from '../../packages/storage/dist/object-storage.js';
import { PostgresGitHubLifecycleRepository } from './github-lifecycle-backfill-repository.ts';

function createRecordingSql(): { sql: postgres.Sql; statements: string[] } {
  const statements: string[] = [];
  const createExecutor = (inTransaction: boolean) =>
    Object.assign(
      async (strings: TemplateStringsArray) => {
        const sqlText = strings.join(' ').replace(/\s+/g, ' ').trim();
        statements.push(sqlText);
        if (inTransaction && sqlText.includes('INSERT INTO public.raw_documents')) {
          return [{ id: '00000000-0000-0000-0000-000000000099' }];
        }
        return [];
      },
      { json: (value: unknown) => value },
    );

  const transaction = createExecutor(true);
  const sql = Object.assign(createExecutor(false), {
    begin: async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      callback(transaction as postgres.TransactionSql),
  }) as postgres.Sql;

  return { sql, statements };
}

function createStorage(): ObjectStorage {
  return {
    async exists() {
      return true;
    },
    async get() {
      throw new Error('not implemented');
    },
    async getText() {
      return '';
    },
    list() {
      return (async function* empty() {})();
    },
    async put() {
      return { uri: 'sample-a/raw/github/test.json' };
    },
  };
}

test('listOpenGitHubLifecycleTargets orders by logicalSourceId only for stable resume', async () => {
  const { sql, statements } = createRecordingSql();
  const repository = new PostgresGitHubLifecycleRepository(sql);
  await repository.listOpenGitHubLifecycleTargets({
    limit: 1,
    projectId: '00000000-0000-0000-0000-000000000001',
  });
  const listQuery = statements.find((statement) => statement.includes('ORDER BY'));
  assert.ok(listQuery);
  assert.match(listQuery ?? '', /logicalSourceId" ASC/);
  assert.doesNotMatch(listQuery ?? '', /lifecycleState/);
});

test('queueLifecycleRefresh links raw_document_data_sources in the same transaction', async () => {
  const { sql, statements } = createRecordingSql();
  const repository = new PostgresGitHubLifecycleRepository(sql, {
    storage: createStorage(),
  });
  const nextLifecycle = normalizeGitHubIssueLifecycle({
    closed_at: '2026-05-08T12:00:00.000Z',
    state: 'closed',
    updated_at: '2026-05-08T12:00:00.000Z',
  });

  const result = await repository.queueLifecycleRefresh({
    dataSourceId: '00000000-0000-0000-0000-000000000010',
    logicalSourceId: 'example-org/repo/issues/101',
    nextLifecycle,
    projectId: '00000000-0000-0000-0000-000000000001',
    projectSlug: 'sample-a',
    rawBody: JSON.stringify({
      body: 'Issue body',
      kind: 'issue',
      number: 101,
      repository: 'example-org/repo',
      title: 'Title',
      updated_at: '2026-05-08T10:00:00.000Z',
    }),
    rawDocumentId: '00000000-0000-0000-0000-000000000020',
    rawMetadata: {
      dataSourceId: '00000000-0000-0000-0000-000000000010',
      kind: 'issue',
      number: 101,
      repository: 'example-org/repo',
    },
    repository: 'example-org/repo',
    sourceUri: 'https://github.com/example-org/repo/issues/101',
  });

  assert.equal(result.queued, true);
  assert.equal(result.rawDocumentId, '00000000-0000-0000-0000-000000000099');
  const transactionStatements = statements.filter((statement) =>
    statement.includes('INSERT INTO public.'),
  );
  assert.equal(transactionStatements.length, 3);
  assert.match(transactionStatements[0] ?? '', /INSERT INTO public\.raw_documents/);
  assert.match(transactionStatements[1] ?? '', /INSERT INTO public\.raw_document_data_sources/);
  assert.match(transactionStatements[2] ?? '', /INSERT INTO public\.ingestion_queue/);
});
