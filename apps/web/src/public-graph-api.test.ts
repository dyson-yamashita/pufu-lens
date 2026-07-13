import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphViewerRepository } from './graph-viewer.ts';
import { parsePublicGraphRequestBody, runPublicGraphApi } from './public-graph-api.ts';

function createRepository(): GraphViewerRepository {
  return {
    async executePreset() {
      throw new Error('not used');
    },
    async fetchDocumentChunks() {
      throw new Error('not used');
    },
    async lookupProjectMember() {
      throw new Error('not used');
    },
    async lookupPublicProject({ projectSlug }) {
      return projectSlug === 'sample-a'
        ? { graphName: 'graph_sample_a', id: 'project-a', name: 'Sample A', slug: 'sample-a' }
        : undefined;
    },
  };
}

test('parsePublicGraphRequestBody accepts queryId and limit', () => {
  assert.deepEqual(parsePublicGraphRequestBody({ limit: 50, queryId: 'recent-relations' }), {
    limit: 50,
    ok: true,
    queryId: 'recent-relations',
  });
});

test('parsePublicGraphRequestBody rejects invalid JSON bodies', () => {
  const result = parsePublicGraphRequestBody([]);
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, 'invalid_json');
});

test('parsePublicGraphRequestBody rejects cypher field', () => {
  const result = parsePublicGraphRequestBody({
    cypher: 'MATCH (n) RETURN n',
    queryId: 'recent-relations',
  });
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, 'cypher_not_allowed');
});

test('runPublicGraphApi returns 404 when public project is not found', async () => {
  const result = await runPublicGraphApi(
    { projectSlug: 'missing-public', queryId: 'recent-relations' },
    { repository: createRepository() },
  );
  if (result.status === 200) {
    assert.fail('expected public project lookup to fail');
  }
  assert.equal(result.status, 404);
  assert.equal(result.error.code, 'public_project_not_found');
});

console.log('web public graph api tests passed');
