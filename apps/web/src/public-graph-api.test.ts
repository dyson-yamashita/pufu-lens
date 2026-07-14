import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphViewerRepository } from './graph-viewer.ts';
import { parsePublicGraphRequestBody, runPublicGraphApi } from './public-graph-api.ts';

function createRepository(): GraphViewerRepository {
  return {
    async executePreset({ cypher, graphName, parameters, preset }) {
      assert.equal(graphName, 'graph_sample_a');
      assert.equal(preset.id, 'recent-relations');
      assert.match(cypher, /\$documentGraphNodeIds/u);
      assert.match(cypher, /LIMIT 500$/);
      assert.deepEqual(parameters.documentGraphNodeIds, ['document:spec']);
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
    async selectEligibleDocumentGraphNodeIds({ limit, projectId }) {
      assert.equal(projectId, 'project-a');
      assert.equal(limit, 50);
      return ['document:spec'];
    },
  };
}

test('parsePublicGraphRequestBody accepts queryId, limit, and period bounds', () => {
  assert.deepEqual(
    parsePublicGraphRequestBody({
      limit: 50,
      periodEnd: '2026-01-31',
      periodStart: '2026-01-01',
      queryId: 'recent-relations',
    }),
    {
      limit: 50,
      ok: true,
      periodEnd: '2026-01-31',
      periodStart: '2026-01-01',
      queryId: 'recent-relations',
    },
  );
});

test('parsePublicGraphRequestBody trims valid period strings', () => {
  assert.deepEqual(
    parsePublicGraphRequestBody({
      periodEnd: ' 2026-01-31 ',
      periodStart: ' 2026-01-01 ',
      queryId: 'recent-relations',
    }),
    {
      ok: true,
      periodEnd: '2026-01-31',
      periodStart: '2026-01-01',
      queryId: 'recent-relations',
    },
  );
});

test('parsePublicGraphRequestBody omits blank period bounds', () => {
  assert.deepEqual(parsePublicGraphRequestBody({ queryId: 'recent-relations' }), {
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

test('parsePublicGraphRequestBody rejects invalid period bounds', () => {
  const result = parsePublicGraphRequestBody({
    periodEnd: '2026-01-01',
    periodStart: '2026-02-01',
    queryId: 'recent-relations',
  });
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, 'invalid_period');
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
  assert.equal(result.body.documentCount, 1);
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
