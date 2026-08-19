import assert from 'node:assert/strict';
import test from 'node:test';
import type postgres from 'postgres';
import { createPostgresAgeGraphReadRepository } from './postgres-graph-read-adapter.ts';

test('AGE graph read adapter exposes project-scoped capability methods', () => {
  const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
  const repository = createPostgresAgeGraphReadRepository(sql);
  assert.equal(typeof repository.findRelatedDocuments, 'function');
  assert.equal(typeof repository.readPreset, 'function');
  assert.equal(typeof repository.countDocumentNode, 'function');
  assert.equal(typeof repository.countRelations, 'function');
});

test('AGE graph read adapter normalizes missing project graph to unavailable', async () => {
  const sql = (() => Promise.resolve([])) as unknown as postgres.Sql;
  const repository = createPostgresAgeGraphReadRepository(sql);
  assert.deepEqual(
    await repository.findRelatedDocuments({
      projectId: '11111111-1111-4111-8111-111111111111',
      seedDocumentIds: ['document-a'],
    }),
    { candidates: [], status: 'unavailable' },
  );
});

test('AGE graph read adapter returns an empty success without touching the provider', async () => {
  const sql = (() => {
    assert.fail('provider query should not run without seed documents');
  }) as unknown as postgres.Sql;
  const repository = createPostgresAgeGraphReadRepository(sql);
  assert.deepEqual(
    await repository.findRelatedDocuments({ projectId: 'project-a', seedDocumentIds: [] }),
    { candidates: [], status: 'success' },
  );
});
