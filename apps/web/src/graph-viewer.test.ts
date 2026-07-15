import assert from 'node:assert/strict';
import {
  buildPresetCypher,
  countGraphDocumentNodes,
  fetchGraphDocumentChunks,
  GraphAccessDeniedError,
  GraphInvalidDocumentIdError,
  GraphLimitError,
  GraphPeriodError,
  GraphPresetNotFoundError,
  type GraphViewerRepository,
  getGraphPreset,
  graphNodeDocumentId,
  listGraphPresets,
  normalizeGraphLimit,
  normalizeGraphPeriodFilter,
  normalizeGraphRows,
  parseEligibleDocumentGraphNodeIdRows,
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
assert.equal(countGraphDocumentNodes(normalized.nodes), 1);

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
assert.equal(countGraphDocumentNodes(normalizedTopic.nodes), 0);

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

assert.deepEqual(parseEligibleDocumentGraphNodeIdRows([{ graph_node_id: 'document:spec' }]), [
  'document:spec',
]);
assert.throws(
  () => parseEligibleDocumentGraphNodeIdRows([{ graph_node_id: 123 }]),
  /graph_node_id/,
);
assert.throws(
  () => parseEligibleDocumentGraphNodeIdRows(['invalid']),
  /Invalid eligible document row/,
);
assert.throws(
  () => parseEligibleDocumentGraphNodeIdRows([{ graph_node_id: '   ' }]),
  /Invalid document graph_node_id/,
);

const recentPreset = getGraphPreset('recent-relations');
assert.match(buildPresetCypher(recentPreset), /LIMIT 500$/);
assert.match(recentPreset.cypherBody, /doc\.graphNodeId <= neighbor\.graphNodeId/u);

function createRepository(expectedLimit = 200): GraphViewerRepository {
  return {
    async executePreset({ cypher, graphName, parameters, preset }) {
      assert.equal(graphName, 'graph_sample_a');
      assert.equal(preset.id, 'recent-relations');
      assert.match(cypher, /\$documentGraphNodeIds/u);
      assert.match(cypher, /LIMIT 500$/);
      assert.deepEqual(parameters.documentGraphNodeIds, ['document:spec']);
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
    async selectEligibleDocumentGraphNodeIds({ limit, periodEnd, periodStart, projectId }) {
      assert.equal(projectId, 'project-a');
      assert.equal(limit, expectedLimit);
      assert.equal(periodStart, undefined);
      assert.equal(periodEnd, undefined);
      return ['document:spec'];
    },
  };
}

const result = await runGraphPresetQuery(
  { limit: 200, projectSlug: 'sample-a', queryId: 'recent-relations', userId: 'user-a' },
  { repository: createRepository() },
);
assert.equal(result.graphName, 'graph_sample_a');
assert.equal(result.limit, 200);
assert.equal(result.documentCount, 1);
assert.match(result.preset.preview, /LIMIT 500$/);
assert.equal(result.nodes.length, 2);
assert.equal('chunks' in (result.nodes[1] ?? {}), false);
assert.equal(result.edges.length, 1);
assert.equal(result.rawRows.length, 1);
assert.equal(result.rowCount, 1);

const publicResult = await runPublicGraphPresetQuery(
  { limit: 50, projectSlug: 'sample-a', queryId: 'recent-relations' },
  { repository: createRepository(50) },
);
assert.equal(publicResult.graphName, 'graph_sample_a');
assert.equal(publicResult.limit, 50);
assert.equal(publicResult.documentCount, 1);
assert.equal(publicResult.nodes.length, 2);

const emptyGraphRepository: GraphViewerRepository = {
  ...createRepository(100),
  async executePreset() {
    return [];
  },
  async selectEligibleDocumentGraphNodeIds() {
    return ['document:missing-a', 'document:missing-b', 'document:missing-c'];
  },
};

const emptyGraphResult = await runGraphPresetQuery(
  { limit: 100, projectSlug: 'sample-a', queryId: 'recent-relations', userId: 'user-a' },
  { repository: emptyGraphRepository },
);
assert.equal(emptyGraphResult.documentCount, 0);
assert.equal(emptyGraphResult.nodes.length, 0);
assert.ok(emptyGraphResult.documentCount <= emptyGraphResult.limit);

const periodRepository: GraphViewerRepository = {
  ...createRepository(100),
  async executePreset({ parameters, preset, graphName, cypher }) {
    assert.equal(graphName, 'graph_sample_a');
    assert.equal(preset.id, 'recent-relations');
    assert.match(cypher, /\$documentGraphNodeIds/u);
    assert.match(cypher, /LIMIT 500$/);
    assert.deepEqual(parameters.documentGraphNodeIds, ['document:period']);
    return [
      {
        relation: `${JSON.stringify(edge)}::edge`,
        source: `${JSON.stringify(actor)}::vertex`,
        target: `${JSON.stringify(document)}::vertex`,
      },
    ];
  },
  async selectEligibleDocumentGraphNodeIds({ periodEnd, periodStart }) {
    assert.equal(periodStart, '2026-01-01');
    assert.equal(periodEnd, '2026-01-31');
    return ['document:period'];
  },
};

const periodResult = await runGraphPresetQuery(
  {
    limit: 100,
    periodEnd: '2026-01-31',
    periodStart: '2026-01-01',
    projectSlug: 'sample-a',
    queryId: 'recent-relations',
    userId: 'user-a',
  },
  { repository: periodRepository },
);
assert.equal(periodResult.documentCount, 1);
assert.equal(periodResult.periodStart, '2026-01-01');
assert.equal(periodResult.periodEnd, '2026-01-31');

let executePresetCalls = 0;
const noEligibleDocumentsRepository: GraphViewerRepository = {
  ...createRepository(100),
  async executePreset() {
    executePresetCalls += 1;
    assert.fail('executePreset should not be called when eligible document IDs are empty');
  },
  async selectEligibleDocumentGraphNodeIds({ periodEnd, periodStart }) {
    assert.equal(periodStart, '2026-01-01');
    assert.equal(periodEnd, '2026-01-31');
    return [];
  },
};

const noEligibleResult = await runGraphPresetQuery(
  {
    limit: 100,
    periodEnd: '2026-01-31',
    periodStart: '2026-01-01',
    projectSlug: 'sample-a',
    queryId: 'recent-relations',
    userId: 'user-a',
  },
  { repository: noEligibleDocumentsRepository },
);
assert.equal(executePresetCalls, 0);
assert.equal(noEligibleResult.documentCount, 0);
assert.equal(noEligibleResult.rowCount, 0);
assert.equal(noEligibleResult.nodes.length, 0);
assert.equal(noEligibleResult.edges.length, 0);
assert.equal(noEligibleResult.rawRows.length, 0);
assert.equal(noEligibleResult.truncated, false);
assert.equal(noEligibleResult.graphName, 'graph_sample_a');
assert.equal(noEligibleResult.limit, 100);
assert.equal(noEligibleResult.periodStart, '2026-01-01');
assert.equal(noEligibleResult.periodEnd, '2026-01-31');
assert.match(noEligibleResult.preset.preview, /LIMIT 500$/);
assert.equal(noEligibleResult.preset.preview, periodResult.preset.preview);

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
assert.match(presetSummary?.preview ?? '', /\$documentGraphNodeIds/u);
assert.match(presetSummary?.preview ?? '', /'Actor' IN labels\(neighbor\)/u);
assert.match(presetSummary?.preview ?? '', /'Topic' IN labels\(neighbor\)/u);
assert.match(presetSummary?.preview ?? '', /'Document' IN labels\(neighbor\)/u);
assert.doesNotMatch(presetSummary?.preview ?? '', /neighbor:(?:Actor|Topic|Document)/u);
assert.match(presetSummary?.preview ?? '', /LIMIT 500$/);
assert.equal(presetSummary?.preview, buildPresetCypher(recentPreset));

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

assert.deepEqual(normalizeGraphPeriodFilter({}), {});
assert.deepEqual(normalizeGraphPeriodFilter({ periodEnd: '', periodStart: '' }), {});
assert.deepEqual(
  normalizeGraphPeriodFilter({ periodEnd: '2026-01-31', periodStart: '2026-01-01' }),
  { periodEnd: '2026-01-31', periodStart: '2026-01-01' },
);
assert.deepEqual(normalizeGraphPeriodFilter({ periodStart: '2026-03-01' }), {
  periodStart: '2026-03-01',
});
assert.throws(
  () => normalizeGraphPeriodFilter({ periodEnd: '2026-01-01', periodStart: '2026-02-01' }),
  GraphPeriodError,
);
assert.throws(() => normalizeGraphPeriodFilter({ periodStart: '2026-13-01' }), GraphPeriodError);
assert.throws(() => normalizeGraphPeriodFilter({ periodStart: 123 }), GraphPeriodError);

console.log('web graph viewer tests passed');
