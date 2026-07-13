import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphViewerRepository } from './graph-viewer.ts';
import { parsePublicGraphRequestBody, runPublicGraphApi } from './public-graph-api.ts';

function createRepository(): GraphViewerRepository {
  return {
    async executePreset({ cypher, graphName, preset }) {
      assert.equal(graphName, 'graph_sample_a');
      assert.equal(preset.id, 'recent-relations');
      assert.match(cypher, /LIMIT 50$/);
      return [
        {
          relation:
            '{"id":"3","label":"AUTHORED","start_id":"1","end_id":"2","properties":{}}::edge',
          source:
            '{"id":"1","label":"Actor","properties":{"displayName":"Ada","graphNodeId":"actor:ada"}}::vertex',
          target:
            '{"id":"2","label":"Document","properties":{"documentId":"doc-a","graphNodeId":"document:spec","title":"Spec"}}::vertex',
        },
      ];
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

test('runPublicGraphApi returns 200 for an accessible public project', async () => {
  const result = await runPublicGraphApi(
    { limit: 50, projectSlug: 'sample-a', queryId: 'recent-relations' },
    { repository: createRepository() },
  );
  assert.equal(result.status, 200);
  if (result.status !== 200) {
    return;
  }
  assert.equal(result.body.graphName, 'graph_sample_a');
  assert.equal(result.body.limit, 50);
});

test('runPublicGraphApi returns 400 for unknown queryId', async () => {
  const result = await runPublicGraphApi(
    { projectSlug: 'sample-a', queryId: 'unknown-preset' },
    { repository: createRepository() },
  );
  if (result.status === 200) {
    assert.fail('expected unknown preset to fail');
  }
  assert.equal(result.status, 400);
  assert.equal(result.error.code, 'unknown_query_id');
});

test('runPublicGraphApi returns 400 for invalid limit', async () => {
  const result = await runPublicGraphApi(
    { limit: 0, projectSlug: 'sample-a', queryId: 'recent-relations' },
    { repository: createRepository() },
  );
  if (result.status === 200) {
    assert.fail('expected invalid limit to fail');
  }
  assert.equal(result.status, 400);
  assert.equal(result.error.code, 'invalid_limit');
});

console.log('web public graph api tests passed');
