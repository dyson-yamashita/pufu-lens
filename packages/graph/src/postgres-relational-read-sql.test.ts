import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
import {
  queryActorDocumentsPreset,
  queryRecentRelationsPreset,
  selectRelatedDocumentCandidates,
} from './postgres-relational-read-sql.js';

test('selectRelatedDocumentCandidates rejects malformed SQL rows fail-closed', () => {
  assert.throws(
    () =>
      selectRelatedDocumentCandidates({
        hopCount: 1,
        limit: 5,
        relationType: 'SAME_AS',
        rows: [null],
      }),
    /Invalid relational related document row/,
  );
  assert.throws(
    () =>
      selectRelatedDocumentCandidates({
        hopCount: 1,
        limit: 5,
        relationType: 'SAME_AS',
        rows: [{ seedDocumentId: 'seed-1', documentId: '' }],
      }),
    /Invalid relational related document row/,
  );
  assert.throws(
    () =>
      selectRelatedDocumentCandidates({
        hopCount: 2,
        limit: 5,
        relationType: 'MENTIONS',
        rows: [{ seedDocumentId: '', documentId: 'doc-1' }],
      }),
    /Invalid relational related document row/,
  );
});

test('selectRelatedDocumentCandidates deduplicates duplicate documentId rows', () => {
  const candidates = selectRelatedDocumentCandidates({
    hopCount: 1,
    limit: 5,
    relationType: 'RELATED_TO',
    rows: [
      { seedDocumentId: 'seed-1', documentId: 'doc-1' },
      { seedDocumentId: 'seed-2', documentId: 'doc-1' },
    ],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.documentId, 'doc-1');
});

test('queryActorDocumentsPreset skips SQL when documentGraphNodeIds is empty', async () => {
  let tagCalls = 0;
  const transaction = ((
    strings: TemplateStringsArray | readonly string[],
    ...values: readonly unknown[]
  ) => {
    tagCalls += 1;
    void strings;
    void values;
    return Promise.resolve([]);
  }) as unknown as postgres.TransactionSql;
  const rows = await queryActorDocumentsPreset(
    transaction,
    '71400000-0000-0000-0000-000000000001',
    [],
  );
  assert.deepEqual(rows, []);
  assert.equal(tagCalls, 0);
});

test('queryRecentRelationsPreset skips SQL when documentGraphNodeIds is empty', async () => {
  let tagCalls = 0;
  const transaction = ((
    strings: TemplateStringsArray | readonly string[],
    ...values: readonly unknown[]
  ) => {
    tagCalls += 1;
    void strings;
    void values;
    return Promise.resolve([]);
  }) as unknown as postgres.TransactionSql;
  const rows = await queryRecentRelationsPreset(
    transaction,
    '71400000-0000-0000-0000-000000000001',
    [],
  );
  assert.deepEqual(rows, []);
  assert.equal(tagCalls, 0);
});
