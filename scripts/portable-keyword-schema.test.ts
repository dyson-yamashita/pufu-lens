import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseMigrationFileContent } from './db-migrate.ts';

test('fresh schema preserves the exact keyword normalizer/trigger and migration seeds', async () => {
  const root = new URL('../infra/', import.meta.url);
  const schema = await readFile(
    new URL('db/migrations/0027_portable_keyword_schema.sql', root),
    'utf8',
  );
  const index = await readFile(
    new URL('db/migrations/0028_portable_keyword_index.sql', root),
    'utf8',
  );
  const init = await readFile(new URL('docker/postgres/init.sql', root), 'utf8');
  // Schema drift's catalog snapshot does not compare function bodies. Pin the shared write/query contract.
  assert.ok(init.includes(schema.trim()));
  assert.ok(init.includes("('0027_portable_keyword_schema')"));
  assert.ok(init.includes("('0028_portable_keyword_index')"));
  const migration = parseMigrationFileContent(index);
  assert.equal(migration.transactionMode, 'non-transactional');
  assert.equal(migration.statements.length, 2);
  assert.match(migration.statements[0] ?? '', /DROP INDEX CONCURRENTLY IF EXISTS/);
  assert.ok(init.includes((migration.statements[1] ?? '').replace(' CONCURRENTLY', '')));
});
