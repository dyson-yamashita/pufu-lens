import assert from 'node:assert/strict';
import test from 'node:test';
import { runGraphDocumentChunksApi } from './graph-document-chunks-api.ts';
import { createPostgresGraphViewerRepository, type GraphViewerRepository } from './graph-viewer.ts';

function createRepository(): GraphViewerRepository {
  return {
    async executePreset() {
      throw new Error('not used');
    },
    async fetchDocumentChunks({ documentIds, projectId }) {
      assert.equal(projectId, 'project-a');
      assert.deepEqual(documentIds, ['doc-a']);
      return new Map([
        [
          'doc-a',
          [
            {
              chunkIndex: 0,
              content: 'Chunk content',
              contentHash: 'hash-a',
              createdAt: '2026-07-11 00:00:00+00',
              id: 'chunk-a',
              metadata: {},
            },
          ],
        ],
      ]);
    },
    async lookupProjectMember({ projectSlug, userId }) {
      return projectSlug === 'sample-a' && userId === 'user-a'
        ? { graphName: 'graph_sample_a', id: 'project-a', name: 'Sample A', slug: 'sample-a' }
        : undefined;
    },
  };
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && 'raw' in value;
}

function createRecordingSql() {
  const statements: string[] = [];

  function createTransaction() {
    const tx = (stringsOrArray: TemplateStringsArray | readonly string[], ...values: unknown[]) => {
      if (isTemplateStringsArray(stringsOrArray)) {
        statements.push(String.raw(stringsOrArray, ...values.map(() => '?')));
        return Promise.resolve([]);
      }
      return stringsOrArray;
    };
    return Object.assign(tx, { unsafe: () => Promise.resolve([]) });
  }

  return {
    sql: Object.assign(createTransaction(), {
      begin: async (fn: (tx: ReturnType<typeof createTransaction>) => Promise<unknown>) =>
        fn(createTransaction()),
    }) as never,
    statements,
  };
}

test('runGraphDocumentChunksApi returns chunks for an accessible project', async () => {
  const result = await runGraphDocumentChunksApi(
    { documentId: 'doc-a', projectSlug: 'sample-a', userId: 'user-a' },
    { repository: createRepository() },
  );
  assert.equal(result.status, 200);
  if (result.status !== 200) {
    return;
  }
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0]?.content, 'Chunk content');
});

test('runGraphDocumentChunksApi returns 403 when project access is denied', async () => {
  const result = await runGraphDocumentChunksApi(
    { documentId: 'doc-a', projectSlug: 'sample-b', userId: 'user-a' },
    { repository: createRepository() },
  );
  if (result.status === 200) {
    assert.fail('expected project access to be denied');
  }
  assert.equal(result.status, 403);
  assert.equal(result.error.code, 'project_access_denied');
});

test('runGraphDocumentChunksApi returns 400 for blank documentId', async () => {
  const result = await runGraphDocumentChunksApi(
    { documentId: '   ', projectSlug: 'sample-a', userId: 'user-a' },
    { repository: createRepository() },
  );
  if (result.status === 200) {
    assert.fail('expected invalid documentId error');
  }
  assert.equal(result.status, 400);
  assert.equal(result.error.code, 'invalid_document_id');
});

test('runGraphDocumentChunksApi propagates unexpected repository errors', async () => {
  await assert.rejects(
    () =>
      runGraphDocumentChunksApi(
        { documentId: 'doc-a', projectSlug: 'sample-a', userId: 'user-a' },
        {
          repository: {
            ...createRepository(),
            async fetchDocumentChunks() {
              throw new Error('db down');
            },
          },
        },
      ),
    /db down/,
  );
});

test('fetchDocumentChunks uses read-only transaction and index-friendly document_id filter', async () => {
  const { sql, statements } = createRecordingSql();
  const repository = createPostgresGraphViewerRepository(sql);
  const result = await repository.fetchDocumentChunks({
    documentIds: ['doc-a'],
    projectId: 'project-a',
  });
  assert.equal(result.size, 0);
  const queryText = statements.join('\n');
  assert.match(queryText, /SET TRANSACTION READ ONLY/);
  assert.match(queryText, /SET LOCAL statement_timeout = '5000ms'/);
  assert.match(queryText, /FROM public\.document_chunks dc/);
  assert.match(queryText, /document_id IN/);
  assert.doesNotMatch(queryText, /document_id::text\s*=/);
});

console.log('web graph document chunks api tests passed');
