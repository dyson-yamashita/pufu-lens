import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const migrationPath = join(
  import.meta.dirname,
  '../infra/db/migrations/0010_source_version_model.sql',
);
const initSqlPath = join(import.meta.dirname, '../infra/docker/postgres/init.sql');

const sourceVersionConstraintNames = [
  'raw_documents_project_source_logical_version_key',
  'documents_project_doc_type_logical_source_key',
  'data_sources_sync_cursor_object_check',
] as const;

test('0010 migration adds source version model columns and constraints', async () => {
  const sql = await readFile(migrationPath, 'utf8');

  assert.match(sql, /ALTER TABLE public\.raw_documents[\s\S]*logical_source_id TEXT/);
  assert.match(sql, /ALTER TABLE public\.raw_documents[\s\S]*source_version TEXT/);
  assert.match(sql, /ALTER TABLE public\.documents[\s\S]*logical_source_id TEXT/);
  assert.match(
    sql,
    /ALTER TABLE public\.data_sources[\s\S]*sync_cursor JSONB NOT NULL DEFAULT '{}'/,
  );
  assert.match(
    sql,
    /ADD CONSTRAINT data_sources_sync_cursor_object_check[\s\S]*jsonb_typeof\(sync_cursor\) = 'object'/,
  );
  assert.match(sql, /last_sync_succeeded_at TIMESTAMPTZ/);
  assert.match(sql, /legacy:' \|\| source_id/);
  assert.match(sql, /raw_documents_project_source_logical_version_key/);
  assert.match(sql, /documents_project_doc_type_logical_source_key/);
  assert.match(sql, /raw_documents_project_source_logical_latest_idx/);
});

test('0010 migration and init.sql share source version constraint names', async () => {
  const [migrationSql, initSql] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(initSqlPath, 'utf8'),
  ]);

  for (const constraintName of sourceVersionConstraintNames) {
    assert.match(migrationSql, new RegExp(constraintName));
    assert.match(initSql, new RegExp(constraintName));
  }

  assert.match(
    initSql,
    /CONSTRAINT raw_documents_project_source_logical_version_key[\s\S]*UNIQUE \(project_id, source_type, logical_source_id, source_version\)/,
  );
  assert.match(
    initSql,
    /CONSTRAINT documents_project_doc_type_logical_source_key[\s\S]*UNIQUE \(project_id, doc_type, logical_source_id\)/,
  );
  assert.match(
    initSql,
    /CONSTRAINT data_sources_sync_cursor_object_check CHECK \(jsonb_typeof\(sync_cursor\) = 'object'\)/,
  );
});
