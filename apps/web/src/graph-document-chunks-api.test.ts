import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runGraphDocumentChunksApi } from './graph-document-chunks-api.ts';
import type { GraphViewerRepository } from './graph-viewer.ts';

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

test('document-chunks route delegates auth errors to requireSessionUserId handling', async () => {
  const source = await readFile(
    new URL('../app/api/projects/[projectSlug]/graph/document-chunks/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /requireSessionUserId\(\)/);
  assert.match(source, /auth_required/);
  assert.match(source, /runGraphDocumentChunksApi/);
  assert.doesNotMatch(
    source,
    /catch \(error\)[\s\S]*AuthRequiredError[\s\S]*fetchGraphDocumentChunks/,
  );
});

test('fetchDocumentChunks applies a read-only transaction timeout', async () => {
  const source = await readFile(new URL('./graph-viewer.ts', import.meta.url), 'utf8');
  const fetchDocumentChunks = source.slice(
    source.indexOf('async fetchDocumentChunks'),
    source.indexOf('async lookupProjectMember'),
  );
  assert.match(fetchDocumentChunks, /sql\.begin/);
  assert.match(fetchDocumentChunks, /SET TRANSACTION READ ONLY/);
  assert.match(fetchDocumentChunks, /SET LOCAL statement_timeout = '5000ms'/);
  assert.match(fetchDocumentChunks, /document_id IN \$\{transaction\(documentIds\)\}/);
  assert.doesNotMatch(fetchDocumentChunks, /document_id::text\s*=/);
});

console.log('web graph document chunks api tests passed');
