import assert from 'node:assert/strict';
import {
  fetchGraphDocumentChunks,
  GraphAccessDeniedError,
  GraphInvalidDocumentIdError,
  GraphLimitError,
  GraphPresetNotFoundError,
  type GraphViewerRepository,
  graphNodeDocumentId,
  listGraphPresets,
  normalizeGraphLimit,
  normalizeGraphRows,
  runGraphPresetQuery,
  runPublicGraphPresetQuery,
} from './graph-viewer.ts';

const actor = {
  id: '1',
  label: 'Actor',
  properties: { displayName: 'Ada', graphNodeId: 'actor:ada' },
};
const document = {
  id: '2',
  label: 'Document',
  properties: { documentId: 'doc-a', graphNodeId: 'document:spec', title: 'Spec' },
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

const topicNode = {
  id: '20',
  label: 'Topic',
  properties: {
    graphNodeId: 'topic:uri:https%3A%2F%2Fnote.com%2Fhashtag%2Fsample',
    target: 'https://note.com/hashtag/sample',
    topicType: 'uri',
  },
};
const normalizedTopic = normalizeGraphRows([{ topic: `${JSON.stringify(topicNode)}::vertex` }], {
  maxEdges: 10,
  maxNodes: 10,
});
assert.equal(normalizedTopic.nodes[0]?.label, 'https://note.com/hashtag/sample');

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

function createRepository(expectedLimit = 200): GraphViewerRepository {
  return {
    async executePreset({ cypher, graphName, preset }) {
      assert.equal(graphName, 'graph_sample_a');
      assert.equal(preset.id, 'recent-relations');
      assert.match(cypher, new RegExp(`LIMIT ${expectedLimit}$`, 'u'));
      return [
        {
          relation: `${JSON.stringify(edge)}::edge`,
          source: `${JSON.stringify(actor)}::vertex`,
          target: `${JSON.stringify(document)}::vertex`,
        },
      ];
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
              metadata: { section: 'intro' },
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
    async lookupPublicProject({ projectSlug }) {
      return projectSlug === 'sample-a'
        ? { graphName: 'graph_sample_a', id: 'project-a', name: 'Sample A', slug: 'sample-a' }
        : undefined;
    },
  };
}

const result = await runGraphPresetQuery(
  { limit: 200, projectSlug: 'sample-a', queryId: 'recent-relations', userId: 'user-a' },
  { repository: createRepository() },
);
assert.equal(result.graphName, 'graph_sample_a');
assert.equal(result.limit, 200);
assert.match(result.preset.preview, /LIMIT 200$/);
assert.equal(result.nodes.length, 2);
assert.equal('chunks' in (result.nodes[1] ?? {}), false);
assert.equal(result.edges.length, 1);
assert.equal(result.rawRows.length, 1);

const publicResult = await runPublicGraphPresetQuery(
  { limit: 50, projectSlug: 'sample-a', queryId: 'recent-relations' },
  { repository: createRepository(50) },
);
assert.equal(publicResult.graphName, 'graph_sample_a');
assert.equal(publicResult.limit, 50);
assert.equal(publicResult.nodes.length, 2);

await assert.rejects(
  () =>
    runPublicGraphPresetQuery(
      { projectSlug: 'missing-public', queryId: 'recent-relations' },
      { repository: createRepository() },
    ),
  GraphAccessDeniedError,
);

const documentNode = {
  id: 'doc-node',
  label: 'Document',
  labels: ['Document'],
  properties: { documentId: 'doc-a', title: 'Spec' },
};
assert.equal(graphNodeDocumentId(documentNode), 'doc-a');

const chunks = await fetchGraphDocumentChunks(
  { documentId: 'doc-a', projectSlug: 'sample-a', userId: 'user-a' },
  { repository: createRepository() },
);
assert.equal(chunks.length, 1);
assert.equal(chunks[0]?.content, 'Chunk content');

await assert.rejects(
  () =>
    fetchGraphDocumentChunks(
      { documentId: 'doc-a', projectSlug: 'sample-b', userId: 'user-a' },
      { repository: createRepository() },
    ),
  GraphAccessDeniedError,
);

await assert.rejects(
  () =>
    fetchGraphDocumentChunks(
      { documentId: '   ', projectSlug: 'sample-a', userId: 'user-a' },
      { repository: createRepository() },
    ),
  GraphInvalidDocumentIdError,
);

const presetSummary = listGraphPresets().find((preset) => preset.id === 'recent-relations');
assert.match(presetSummary?.preview ?? '', /LIMIT 100$/);

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

assert.equal(normalizeGraphLimit(1), 1);
assert.equal(normalizeGraphLimit(500), 500);
assert.equal(normalizeGraphLimit(50, 50), 50);
assert.throws(() => normalizeGraphLimit(0), GraphLimitError);
assert.throws(() => normalizeGraphLimit(501), GraphLimitError);
assert.throws(() => normalizeGraphLimit(10.5), GraphLimitError);
assert.throws(() => normalizeGraphLimit(51, 50), /between 1 and 50/);

console.log('web graph viewer tests passed');
