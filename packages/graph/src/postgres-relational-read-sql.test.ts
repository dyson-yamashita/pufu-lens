import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRelatedDocumentCandidates } from './postgres-relational-read-sql.js';

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
