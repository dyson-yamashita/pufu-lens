import assert from 'node:assert/strict';
import {
  GraphAccessDeniedError,
  GraphPresetNotFoundError,
  type GraphViewerRepository,
  normalizeGraphRows,
  runGraphPresetQuery
} from './graph-viewer.ts';

const actor = {
  id: '1',
  label: 'Actor',
  properties: { displayName: 'Ada', graphNodeId: 'actor:ada' }
};
const document = {
  id: '2',
  label: 'Document',
  properties: { graphNodeId: 'document:spec', title: 'Spec' }
};
const edge = {
  end_id: '2',
  id: '3',
  label: 'AUTHORED',
  properties: { sourceType: 'github' },
  start_id: '1'
};

const normalized = normalizeGraphRows(
  [
    {
      relation: `${JSON.stringify(edge)}::edge`,
      source: `${JSON.stringify(actor)}::vertex`,
      target: `${JSON.stringify(document)}::vertex`
    }
  ],
  { maxEdges: 10, maxNodes: 10 }
);

assert.equal(normalized.nodes.length, 2);
assert.equal(normalized.edges.length, 1);
assert.equal(normalized.nodes[0]?.id, '1');
assert.equal(normalized.nodes[1]?.label, 'Spec');
assert.equal(normalized.edges[0]?.label, 'AUTHORED');

const limited = normalizeGraphRows(
  [
    { first: `${JSON.stringify(actor)}::vertex` },
    { second: `${JSON.stringify(document)}::vertex` }
  ],
  { maxEdges: 10, maxNodes: 1 }
);
assert.equal(limited.nodes.length, 1);
assert.equal(limited.truncated, true);

function createRepository(): GraphViewerRepository {
  return {
    async executePreset({ graphName, preset }) {
      assert.equal(graphName, 'graph_sample_a');
      assert.equal(preset.id, 'recent-relations');
      return [
        {
          relation: `${JSON.stringify(edge)}::edge`,
          source: `${JSON.stringify(actor)}::vertex`,
          target: `${JSON.stringify(document)}::vertex`
        }
      ];
    },
    async lookupProjectMember({ projectSlug, userId }) {
      return projectSlug === 'sample-a' && userId === 'user-a'
        ? { graphName: 'graph_sample_a', id: 'project-a', name: 'Sample A', slug: 'sample-a' }
        : undefined;
    }
  };
}

const result = await runGraphPresetQuery(
  { projectSlug: 'sample-a', queryId: 'recent-relations', userId: 'user-a' },
  { repository: createRepository() }
);
assert.equal(result.graphName, 'graph_sample_a');
assert.equal(result.nodes.length, 2);
assert.equal(result.edges.length, 1);
assert.equal(result.rawRows.length, 1);

await assert.rejects(
  () =>
    runGraphPresetQuery(
      { projectSlug: 'sample-a', queryId: 'missing', userId: 'user-a' },
      { repository: createRepository() }
    ),
  GraphPresetNotFoundError
);

await assert.rejects(
  () =>
    runGraphPresetQuery(
      { projectSlug: 'sample-b', queryId: 'recent-relations', userId: 'user-a' },
      { repository: createRepository() }
    ),
  GraphAccessDeniedError
);

console.log('web graph viewer tests passed');
