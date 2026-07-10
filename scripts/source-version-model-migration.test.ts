import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { deriveStoredSourceIdentity } from '../packages/ingestion/src/source-version-identity.ts';

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

const contentHash = 'a'.repeat(64);

/**
 * Shared backfill contract for migration 0010 and deriveStoredSourceIdentity.
 * Update this table whenever either side changes source-specific identity rules.
 */
const rawDocumentsIdentityBackfillContract = [
  {
    label: 'gmail',
    sqlLogicalFragments: ["metadata ->> 'threadId'", "split_part(rd.source_id, ':', 1)"],
    sqlVersionFragments: ["metadata ->> 'messageId'", "split_part(rd.source_id, ':', 2)"],
    typescript: {
      input: {
        contentHash,
        metadata: { messageId: 'msg-1', threadId: 'thread-1' },
        sourceId: 'thread-1:msg-1',
        sourceType: 'gmail' as const,
      },
      expected: {
        logicalSourceId: 'thread-1',
        sourceVersion: 'msg-1',
      },
    },
  },
  {
    label: 'drive',
    sqlLogicalFragments: ["metadata ->> 'fileId'", "split_part(rd.source_id, ':', 1)"],
    sqlVersionFragments: ["metadata ->> 'revisionId'", "split_part(rd.source_id, ':', 2)"],
    typescript: {
      input: {
        contentHash,
        metadata: { fileId: 'file-1', revisionId: 'rev-1' },
        sourceId: 'file-1:rev-1',
        sourceType: 'drive' as const,
      },
      expected: {
        logicalSourceId: 'file-1',
        sourceVersion: 'rev-1',
      },
    },
  },
  {
    label: 'github',
    sqlLogicalFragments: ["WHEN 'github' THEN rd.source_id"],
    sqlVersionFragments: ["metadata ->> 'updatedAt'", "'unknown'", "|| ':' || rd.content_hash"],
    typescript: {
      input: {
        contentHash,
        metadata: { updatedAt: '2026-05-01T00:00:00.000Z' },
        sourceId: 'org/repo/issues/1',
        sourceType: 'github' as const,
      },
      expected: {
        logicalSourceId: 'org/repo/issues/1',
        sourceVersion: `2026-05-01T00:00:00.000Z:${contentHash}`,
      },
    },
  },
  {
    label: 'github-without-updated-at',
    sqlLogicalFragments: ["WHEN 'github' THEN rd.source_id"],
    sqlVersionFragments: ["COALESCE(NULLIF(btrim(rd.metadata ->> 'updatedAt'), ''), 'unknown')"],
    typescript: {
      input: {
        contentHash,
        metadata: {},
        sourceId: 'org/repo/issues/2',
        sourceType: 'github' as const,
      },
      expected: {
        logicalSourceId: 'org/repo/issues/2',
        sourceVersion: `unknown:${contentHash}`,
      },
    },
  },
  {
    label: 'web',
    sqlLogicalFragments: ["WHEN 'web' THEN rd.source_id"],
    sqlVersionFragments: ["WHEN 'web' THEN rd.content_hash"],
    typescript: {
      input: {
        contentHash,
        metadata: {},
        sourceId: 'https://example.test/page',
        sourceType: 'web' as const,
      },
      expected: {
        logicalSourceId: 'https://example.test/page',
        sourceVersion: contentHash,
      },
    },
  },
  {
    label: 'legacy-fallback',
    sqlLogicalFragments: ["logical_source_id = 'legacy:' || source_id"],
    sqlVersionFragments: ['source_version = content_hash'],
    typescript: {
      input: {
        contentHash,
        metadata: {},
        sourceId: 'orphan-source',
        sourceType: 'gmail' as const,
      },
      expected: {
        logicalSourceId: 'legacy:orphan-source',
        sourceVersion: contentHash,
      },
    },
  },
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

test('0010 migration backfill contract matches deriveStoredSourceIdentity rules', async () => {
  const migrationSql = await readFile(migrationPath, 'utf8');
  const backfillUpdate = migrationSql.match(
    /UPDATE public\.raw_documents AS rd[\s\S]*?WHERE rd\.logical_source_id IS NULL/,
  )?.[0];
  assert.ok(backfillUpdate, 'expected raw_documents backfill UPDATE block');

  for (const rule of rawDocumentsIdentityBackfillContract) {
    const sqlScope =
      rule.label === 'legacy-fallback' ? migrationSql : (backfillUpdate ?? migrationSql);

    for (const fragment of rule.sqlLogicalFragments) {
      assert.match(
        sqlScope,
        new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${rule.label} logical SQL fragment missing: ${fragment}`,
      );
    }
    for (const fragment of rule.sqlVersionFragments) {
      assert.match(
        sqlScope,
        new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${rule.label} version SQL fragment missing: ${fragment}`,
      );
    }

    assert.deepEqual(
      deriveStoredSourceIdentity(rule.typescript.input),
      rule.typescript.expected,
      `TypeScript identity derivation diverged for ${rule.label}`,
    );
  }
});
