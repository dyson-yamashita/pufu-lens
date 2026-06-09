import assert from 'node:assert/strict';
import {
  GraphAccessDeniedError,
  GraphPresetNotFoundError,
  type GraphViewerRepository,
  normalizeGraphRows,
  runGraphPresetQuery,
} from './graph-viewer.ts';

const actor = {
  id: '1',
  label: 'Actor',
  properties: { displayName: 'Ada', graphNodeId: 'actor:ada' },
};
const document = {
  id: '2',
  label: 'Document',
  properties: { graphNodeId: 'document:spec', title: 'Spec' },
};
const edge = {
  end_id: '2',
  id: '3',
  label: 'AUTHORED',
  properties: { sourceType: 'github' },
  start_id: '1',
};

const normalized = normalizeGraphRows(
  [
    {
      relation: `${JSON.stringify(edge)}::edge`,
      source: `${JSON.stringify(actor)}::vertex`,
      target: `${JSON.stringify(document)}::vertex`,
    },
  ],
  { maxEdges: 10, maxNodes: 10 },
);

assert.equal(normalized.nodes.length, 2);
assert.equal(normalized.edges.length, 1);
assert.equal(normalized.nodes[0]?.id, '1');
assert.equal(normalized.nodes[1]?.label, 'Spec');
assert.equal(normalized.edges[0]?.label, 'AUTHORED');

const nestedActor = {
  id: '10',
  label: 'Actor',
  properties: {
    displayName: 'Nested Ada',
    graphNodeId: 'actor:nested-ada',
    metadata: {
      author: {
        note: 'literal { brace } and escaped "quote"',
      },
    },
  },
};
const nestedDocument = {
  id: '11',
  label: 'Document',
  properties: {
    graphNodeId: 'document:nested-spec',
    title: 'Nested Spec',
  },
};
const nestedEdge = {
  end_id: '11',
  id: '12',
  label: 'REFERENCES',
  properties: { metadata: { confidence: { score: 0.9 } } },
  start_id: '10',
};
const normalizedPath = normalizeGraphRows(
  [
    {
      path: `[${JSON.stringify(nestedActor)}::vertex, ${JSON.stringify(
        nestedEdge,
      )}::edge, ${JSON.stringify(nestedDocument)}::vertex]::path`,
    },
  ],
  { maxEdges: 10, maxNodes: 10 },
);
assert.equal(normalizedPath.nodes.length, 2);
assert.equal(normalizedPath.edges.length, 1);
assert.equal(normalizedPath.nodes[0]?.label, 'Nested Ada');
assert.equal(normalizedPath.edges[0]?.source, '10');
assert.equal(normalizedPath.edges[0]?.target, '11');

const malformedAgtype = normalizeGraphRows(
  [
    {
      brokenEdge: '{"id": "::edge',
      brokenVertex: '{"id": "::vertex',
      source: `${JSON.stringify(actor)}::vertex`,
    },
  ],
  { maxEdges: 10, maxNodes: 10 },
);
assert.equal(malformedAgtype.nodes.length, 1);
assert.equal(malformedAgtype.edges.length, 0);

const limited = normalizeGraphRows(
  [
    { first: `${JSON.stringify(actor)}::vertex` },
    { second: `${JSON.stringify(document)}::vertex` },
  ],
  { maxEdges: 10, maxNodes: 1 },
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
          target: `${JSON.stringify(document)}::vertex`,
        },
      ];
    },
    async lookupProjectMember({ projectSlug, userId }) {
      return projectSlug === 'sample-a' && userId === 'user-a'
        ? { graphName: 'graph_sample_a', id: 'project-a', name: 'Sample A', slug: 'sample-a' }
        : undefined;
    },
  };
}

const result = await runGraphPresetQuery(
  { projectSlug: 'sample-a', queryId: 'recent-relations', userId: 'user-a' },
  { repository: createRepository() },
);
assert.equal(result.graphName, 'graph_sample_a');
assert.equal(result.nodes.length, 2);
assert.equal(result.edges.length, 1);
assert.equal(result.rawRows.length, 1);

await assert.rejects(
  () =>
    runGraphPresetQuery(
      { projectSlug: 'sample-a', queryId: 'missing', userId: 'user-a' },
      { repository: createRepository() },
    ),
  GraphPresetNotFoundError,
);

await assert.rejects(
  () =>
    runGraphPresetQuery(
      { projectSlug: 'sample-b', queryId: 'recent-relations', userId: 'user-a' },
      { repository: createRepository() },
    ),
  GraphAccessDeniedError,
);

console.log('web graph viewer tests passed');
