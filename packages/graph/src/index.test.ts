import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type GraphReadRepository,
  parseGraphCountResult,
  parseGraphPresetId,
  parseGraphPresetReadResult,
  parseGraphReadEdge,
  parseGraphReadNode,
  parseGraphRelatedDocumentCandidate,
  parseGraphRelationTypes,
} from './index.js';

test('parseGraphRelatedDocumentCandidate accepts a provider-neutral candidate', () => {
  assert.deepEqual(
    parseGraphRelatedDocumentCandidate({
      documentId: 'document-b',
      hopCount: 2,
      relationType: 'MENTIONS',
      seedDocumentId: 'document-a',
    }),
    {
      documentId: 'document-b',
      hopCount: 2,
      relationType: 'MENTIONS',
      seedDocumentId: 'document-a',
    },
  );
});

test('parseGraphRelatedDocumentCandidate rejects invalid identifiers, hops, and relations', () => {
  const valid = {
    documentId: 'document-b',
    hopCount: 1,
    relationType: 'RELATED_TO',
    seedDocumentId: 'document-a',
  };
  assert.throws(() => parseGraphRelatedDocumentCandidate({ ...valid, documentId: ' ' }));
  assert.throws(() => parseGraphRelatedDocumentCandidate({ ...valid, seedDocumentId: '' }));
  assert.throws(() => parseGraphRelatedDocumentCandidate({ ...valid, hopCount: 3 }));
  assert.throws(() => parseGraphRelatedDocumentCandidate({ ...valid, relationType: 'AUTHORED' }));
});

test('parseGraphReadNode validates normalized node fields', () => {
  const node = {
    id: 'node-a',
    label: 'Document A',
    labels: ['Document'],
    properties: { documentId: 'document-a' },
  };
  assert.deepEqual(parseGraphReadNode(node), node);
  assert.throws(() => parseGraphReadNode({ ...node, labels: ['Document', 1] }));
  assert.throws(() => parseGraphReadNode({ ...node, properties: [] }));
  assert.throws(() => parseGraphReadNode({ ...node, properties: { raw: 1n } }));
});

test('parseGraphReadEdge validates normalized edge fields', () => {
  const edge = {
    id: 'edge-a',
    label: 'RELATED_TO',
    properties: {},
    source: 'node-a',
    target: 'node-b',
  };
  assert.deepEqual(parseGraphReadEdge(edge), edge);
  assert.throws(() => parseGraphReadEdge({ ...edge, source: '' }));
  assert.throws(() => parseGraphReadEdge({ ...edge, target: 1 }));
  assert.throws(() => parseGraphReadEdge({ ...edge, properties: { raw: undefined } }));
});

test('parseGraphPresetReadResult validates nested graph data and compatibility fields', () => {
  const result = {
    edges: [
      {
        id: 'edge-a',
        label: 'RELATED_TO',
        properties: {},
        source: 'node-a',
        target: 'node-b',
      },
    ],
    nodes: [
      { id: 'node-a', label: 'Document A', labels: ['Document'], properties: {} },
      { id: 'node-b', label: 'Document B', labels: ['Document'], properties: {} },
    ],
    preview: 'server-owned provider preview',
    rawRows: [{ source: 'safe-json' }],
    rowCount: 1,
    truncated: false,
  };
  assert.deepEqual(parseGraphPresetReadResult(result), result);
  assert.throws(() => parseGraphPresetReadResult({ ...result, rowCount: -1 }));
  assert.throws(() =>
    parseGraphPresetReadResult({ ...result, nodes: [{ ...result.nodes[0], labels: [1] }] }),
  );
  assert.throws(() =>
    parseGraphPresetReadResult({ ...result, edges: [{ ...result.edges[0], id: '' }] }),
  );
});

test('parseGraphCountResult accepts only non-negative integers', () => {
  assert.equal(parseGraphCountResult(0), 0);
  assert.equal(parseGraphCountResult(3), 3);
  assert.throws(() => parseGraphCountResult(-1));
  assert.throws(() => parseGraphCountResult(1.5));
  assert.throws(() => parseGraphCountResult('1'));
});

test('graph enum guards reject provider query fragments and unknown relations', () => {
  assert.equal(parseGraphPresetId('recent-relations'), 'recent-relations');
  assert.throws(() => parseGraphPresetId('MATCH (n) RETURN n'));
  assert.deepEqual(parseGraphRelationTypes(['SENT', 'RELATED_TO', 'SENT']), ['SENT', 'RELATED_TO']);
  assert.throws(() => parseGraphRelationTypes(['SENT) MATCH (n)']));
});

test('GraphReadRepository methods are scoped only by validated project identifiers', async () => {
  const repository = {
    async countDocumentNode(input) {
      assert.deepEqual(input, { graphNodeId: 'node-a', projectId: 'project-a' });
      return 1;
    },
    async countRelations(input) {
      assert.deepEqual(input, {
        graphNodeId: 'node-a',
        projectId: 'project-a',
        relationTypes: ['RELATED_TO'],
      });
      return { RELATED_TO: 1 };
    },
    async findRelatedDocuments(input) {
      assert.deepEqual(input, {
        projectId: 'project-a',
        seedDocumentIds: ['document-a'],
      });
      return { candidates: [], status: 'success' as const };
    },
    async readPreset(input) {
      assert.deepEqual(input, {
        documentGraphNodeIds: ['node-a'],
        presetId: 'recent-relations',
        projectId: 'project-a',
      });
      return {
        edges: [],
        nodes: [],
        preview: 'preview',
        rawRows: [],
        rowCount: 0,
        truncated: false,
      };
    },
  } satisfies GraphReadRepository;

  await repository.findRelatedDocuments({
    projectId: 'project-a',
    seedDocumentIds: ['document-a'],
  });
  await repository.readPreset({
    documentGraphNodeIds: ['node-a'],
    presetId: 'recent-relations',
    projectId: 'project-a',
  });
  await repository.countDocumentNode({ graphNodeId: 'node-a', projectId: 'project-a' });
  await repository.countRelations({
    graphNodeId: 'node-a',
    projectId: 'project-a',
    relationTypes: ['RELATED_TO'],
  });
});
