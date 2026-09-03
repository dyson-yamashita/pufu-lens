import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObjectInfo, ObjectStorage } from '@pufu-lens/storage';
import type postgres from 'postgres';
import { createPostgresGraphRebuildIndexingRepository } from './postgres-graph-indexing-adapter.ts';

const GRAPH_REBUILD_RESUME_CURSOR_DIGEST_SQL =
  "encode(sha256(convert_to(rd.id::text, 'UTF8')), 'hex')";

test('postgres graph rebuild readGraphTargets scopes selection to current parsed documents with digest cursor', async () => {
  const projectId = '00000000-0000-0000-0000-000000000001';
  const captures: SqlCapture[] = [];
  const transaction = createMockTransaction(captures);
  const storage = createThrowingStorage();
  const repository = createPostgresGraphRebuildIndexingRepository(transaction, storage);
  const resumeCursor = 'a'.repeat(64);

  const targets = await repository.readGraphTargets({
    limit: 7,
    projectId,
    resumeCursor,
  });

  assert.deepEqual(targets, []);
  assert.equal(captures.length, 1);
  const capture = captures[0];
  assert.ok(capture);
  const query = buildSqlFromCapture(capture);
  assertProjectScopedParsedDocumentQuery(query, capture, {
    limit: 7,
    projectId,
    resumeCursor,
  });
});

test('postgres graph rebuild readGraphTargets binds null cursor values when resume cursor is absent', async () => {
  const projectId = '00000000-0000-0000-0000-000000000002';
  const captures: SqlCapture[] = [];
  const transaction = createMockTransaction(captures);
  const storage = createThrowingStorage();
  const repository = createPostgresGraphRebuildIndexingRepository(transaction, storage);

  const targets = await repository.readGraphTargets({
    limit: 7,
    projectId,
  });

  assert.deepEqual(targets, []);
  assert.equal(captures.length, 1);
  const capture = captures[0];
  assert.ok(capture);
  const query = buildSqlFromCapture(capture);
  assertProjectScopedParsedDocumentQuery(query, capture, {
    limit: 7,
    projectId,
    resumeCursor: null,
  });
});

type SqlCapture = {
  strings: TemplateStringsArray;
  values: readonly unknown[];
};

function createMockTransaction(captures: SqlCapture[]): postgres.TransactionSql {
  const transaction = (async (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<readonly unknown[]> => {
    captures.push({ strings, values });
    return [];
  }) as postgres.TransactionSql;
  return transaction;
}

function createThrowingStorage(): ObjectStorage {
  return {
    async exists(): Promise<boolean> {
      return false;
    },
    async get(): Promise<NodeJS.ReadableStream> {
      throw new Error('Not implemented.');
    },
    async getText(): Promise<string> {
      throw new Error('Object storage should not be called when SQL returns no rows.');
    },
    async *list(_prefix: string): AsyncIterable<ObjectInfo> {},
    async put(): Promise<{ uri: string }> {
      throw new Error('Not implemented.');
    },
  };
}

function normalizeWhitespace(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function buildSqlFromCapture(capture: SqlCapture): string {
  let sql = '';
  for (let index = 0; index < capture.strings.length; index += 1) {
    sql += capture.strings[index];
    if (index < capture.values.length) {
      sql += `$${index + 1}`;
    }
  }
  return normalizeWhitespace(sql);
}

function assertProjectScopedParsedDocumentQuery(
  query: string,
  capture: SqlCapture,
  expected: {
    limit: number;
    projectId: string;
    resumeCursor: string | null;
  },
): void {
  assert.match(query, /d\.project_id = \$1/);
  assert.match(query, /rd\.project_id = \$2/);
  assert.match(query, /rd\.parsed_uri IS NOT NULL/);
  assert.match(query, /rd\.ingest_status IN \('parsed', 'indexed'\)/);
  assert.ok(
    query.includes(`( $3::text IS NULL OR ${GRAPH_REBUILD_RESUME_CURSOR_DIGEST_SQL} > $4 )`),
  );
  assert.ok(query.includes(`ORDER BY ${GRAPH_REBUILD_RESUME_CURSOR_DIGEST_SQL}, rd.id`));
  assert.match(query, /LIMIT \$5/);
  assert.deepEqual(capture.values, [
    expected.projectId,
    expected.projectId,
    expected.resumeCursor,
    expected.resumeCursor,
    expected.limit,
  ]);
  assert.doesNotMatch(query, /cypher\(/);
  assert.doesNotMatch(query, /ingest_status DESC/);
  assert.doesNotMatch(query, /public\.data_sources/);
  assert.doesNotMatch(query, /data_source_id/);
  assert.doesNotMatch(query, /source_type/);
}
