import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type GraphIndexingRepository,
  type GraphMutationRepository,
  type GraphReadRepository,
  type ProjectResolver,
  parseGraphActorMergeInput,
  parseGraphActorMergeResult,
  parseGraphCountResult,
  parseGraphDocumentCleanupInput,
  parseGraphDocumentCleanupResult,
  parseGraphMutationEdgeInput,
  parseGraphMutationNodeInput,
  parseGraphPresetId,
  parseGraphPresetReadResult,
  parseGraphProjectMutationInput,
  parseGraphProjectResolverResult,
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

test('parseGraphProjectResolverResult accepts only projectId and projectSlug', () => {
  assert.deepEqual(
    parseGraphProjectResolverResult({
      projectId: 'project-a',
      projectSlug: 'sample-a',
    }),
    { projectId: 'project-a', projectSlug: 'sample-a' },
  );
  assert.throws(() => parseGraphProjectResolverResult({ projectId: '', projectSlug: 'sample-a' }));
  assert.throws(() =>
    parseGraphProjectResolverResult({ projectId: 'project-a', projectSlug: ' ' }),
  );
  assert.throws(() =>
    parseGraphProjectResolverResult({
      graphName: 'graph_sample_a',
      projectId: 'project-a',
      projectSlug: 'sample-a',
    }),
  );
});

test('parseGraphMutationNodeInput validates project-scoped normalized node fields', () => {
  const node = {
    graphNodeId: 'node-a',
    labels: ['Document'],
    projectId: 'project-a',
    properties: { documentId: 'document-a' },
  };
  assert.deepEqual(parseGraphMutationNodeInput(node), node);
  assert.throws(() => parseGraphMutationNodeInput({ ...node, graphNodeId: '' }));
  assert.throws(() => parseGraphMutationNodeInput({ ...node, labels: [] }));
  assert.throws(() => parseGraphMutationNodeInput({ ...node, labels: ['Document', 1] }));
  assert.throws(() => parseGraphMutationNodeInput({ ...node, projectId: '' }));
  assert.throws(() => parseGraphMutationNodeInput({ ...node, properties: { raw: 1n } }));
  assert.throws(() => parseGraphMutationNodeInput({ ...node, properties: { raw: undefined } }));
  assert.throws(() => parseGraphMutationNodeInput({ ...node, graphName: 'graph_a' }));
  const cyclicObject: Record<string, unknown> = { nested: { value: 1 } };
  cyclicObject.self = cyclicObject;
  assert.throws(() => parseGraphMutationNodeInput({ ...node, properties: cyclicObject }));
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  assert.throws(() => parseGraphMutationNodeInput({ ...node, properties: { items: cyclicArray } }));
  const sharedNested = { value: 1 };
  assert.deepEqual(
    parseGraphMutationNodeInput({
      ...node,
      properties: { first: sharedNested, second: sharedNested },
    }),
    {
      ...node,
      properties: { first: sharedNested, second: sharedNested },
    },
  );
});

test('parseGraphMutationEdgeInput validates project-scoped allowlisted relation edges', () => {
  const edge = {
    fromGraphNodeId: 'node-a',
    projectId: 'project-a',
    properties: { confidence: 1 },
    relationType: 'RELATED_TO',
    toGraphNodeId: 'node-b',
  };
  assert.deepEqual(parseGraphMutationEdgeInput(edge), edge);
  assert.throws(() => parseGraphMutationEdgeInput({ ...edge, fromGraphNodeId: '' }));
  assert.throws(() => parseGraphMutationEdgeInput({ ...edge, toGraphNodeId: 1 }));
  assert.throws(() => parseGraphMutationEdgeInput({ ...edge, relationType: 'AUTHORED)' }));
  assert.throws(() => parseGraphMutationEdgeInput({ ...edge, properties: { raw: undefined } }));
  assert.throws(() => parseGraphMutationEdgeInput({ ...edge, graphName: 'graph_a' }));
  const cyclicEdgeProperties: Record<string, unknown> = { nested: { value: 1 } };
  cyclicEdgeProperties.self = cyclicEdgeProperties;
  assert.throws(() => parseGraphMutationEdgeInput({ ...edge, properties: cyclicEdgeProperties }));
});

test('parseGraphProjectMutationInput validates project-scoped lifecycle inputs', () => {
  assert.deepEqual(parseGraphProjectMutationInput({ projectId: 'project-a' }), {
    projectId: 'project-a',
  });
  assert.throws(() => parseGraphProjectMutationInput({ projectId: '' }));
  assert.throws(() =>
    parseGraphProjectMutationInput({ projectId: 'project-a', graphName: 'graph_a' }),
  );
});

test('parseGraphActorMergeInput and result stay provider-neutral', () => {
  const mergeInput = {
    primaryActorId: 'actor-primary',
    primaryGraphNodeId: 'actor:primary',
    projectId: 'project-a',
    secondaryGraphNodeId: 'actor:secondary',
  };
  assert.deepEqual(parseGraphActorMergeInput(mergeInput), mergeInput);
  assert.throws(() => parseGraphActorMergeInput({ ...mergeInput, primaryActorId: '' }));
  assert.throws(() => parseGraphActorMergeInput({ ...mergeInput, graphName: 'graph_a' }));

  assert.deepEqual(parseGraphActorMergeResult({ deletedCount: 1, status: 'merged' }), {
    deletedCount: 1,
    status: 'merged',
  });
  assert.deepEqual(
    parseGraphActorMergeResult({
      reason: 'secondary actor graph node not found',
      status: 'skipped',
    }),
    { reason: 'secondary actor graph node not found', status: 'skipped' },
  );
  assert.deepEqual(parseGraphActorMergeResult({ status: 'unavailable' }), {
    status: 'unavailable',
  });
  assert.throws(() => parseGraphActorMergeResult({ deletedCount: -1, status: 'merged' }));
  assert.throws(() => parseGraphActorMergeResult({ reason: '', status: 'skipped' }));
  assert.throws(() =>
    parseGraphActorMergeResult({
      reason: 'secondary actor graph node not found',
      status: 'skipped',
      providerSql: 'SELECT 1',
    }),
  );
});

test('parseGraphDocumentCleanupInput and result reject provider fields and unsafe values', () => {
  const cleanupInput = {
    graphNodeIds: ['document:email:msg-a'],
    projectId: 'project-a',
  };
  assert.deepEqual(parseGraphDocumentCleanupInput(cleanupInput), cleanupInput);
  assert.throws(() => parseGraphDocumentCleanupInput({ ...cleanupInput, graphNodeIds: [' '] }));
  assert.throws(() => parseGraphDocumentCleanupInput({ ...cleanupInput, projectId: '' }));
  assert.throws(() => parseGraphDocumentCleanupInput({ ...cleanupInput, graphNodeIds: [] }));
  assert.throws(() => parseGraphDocumentCleanupInput({ ...cleanupInput, graphName: 'graph_a' }));

  assert.equal(parseGraphDocumentCleanupResult({ deletedCount: 2 }), 2);
  assert.throws(() => parseGraphDocumentCleanupResult({ deletedCount: 1.5 }));
  assert.throws(() => parseGraphDocumentCleanupResult({ deletedCount: 0, rawRows: [] }));
});

test('ProjectResolver returns only bootstrap project identifiers', async () => {
  const resolver = {
    async resolveBySlug(slug: string) {
      assert.equal(slug, 'sample-a');
      return { projectId: 'project-a', projectSlug: 'sample-a' };
    },
  } satisfies ProjectResolver;

  assert.deepEqual(await resolver.resolveBySlug('sample-a'), {
    projectId: 'project-a',
    projectSlug: 'sample-a',
  });
});

test('GraphIndexingRepository methods are scoped by projectId without graph mutation', async () => {
  const repository = {
    async findActorByAlias(input) {
      assert.deepEqual(input, {
        aliasType: 'email',
        aliasValue: 'sender@example.test',
        projectId: 'project-a',
      });
      return undefined;
    },
    async findActorByGraphNodeId(input) {
      assert.deepEqual(input, { graphNodeId: 'actor:email:sender', projectId: 'project-a' });
      return undefined;
    },
    async findDocumentsBySourceIds(input) {
      assert.deepEqual(input, { projectId: 'project-a', sourceIds: ['source-a'] });
      return [];
    },
    async findSameAsDocuments(input) {
      assert.deepEqual(input, {
        projectId: 'project-a',
        rawContentHash: 'hash-a',
        rawDocumentId: 'raw-a',
        sourceType: 'gmail',
      });
      return [];
    },
    async markFailed(input) {
      assert.deepEqual(input, {
        errorMessage: 'failed',
        projectId: 'project-a',
        rawDocumentId: 'raw-a',
      });
    },
    async markIndexed(input) {
      assert.deepEqual(input, { projectId: 'project-a', rawDocumentId: 'raw-a' });
    },
    async readGraphTargets(input) {
      assert.deepEqual(input, { limit: 10, projectId: 'project-a' });
      return [];
    },
    async replaceEmailQuotes(input) {
      assert.deepEqual(input, {
        documentId: 'document-a',
        projectId: 'project-a',
        quotes: [],
      });
    },
  } satisfies GraphIndexingRepository;

  await repository.readGraphTargets({ limit: 10, projectId: 'project-a' });
  await repository.markIndexed({ projectId: 'project-a', rawDocumentId: 'raw-a' });
});

test('GraphMutationRepository methods accept only provider-neutral project-scoped inputs', async () => {
  const repository = {
    async deleteDocumentGraphNodes(input) {
      assert.deepEqual(input, {
        graphNodeIds: ['document:email:msg-a'],
        projectId: 'project-a',
      });
      return 1;
    },
    async deleteProjectGraph(input) {
      assert.deepEqual(input, { projectId: 'project-a' });
    },
    async ensureProjectGraph(input) {
      assert.deepEqual(input, { projectId: 'project-a' });
    },
    async mergeActorGraphNodes(input) {
      assert.deepEqual(input, {
        primaryActorId: 'actor-primary',
        primaryGraphNodeId: 'actor:primary',
        projectId: 'project-a',
        secondaryGraphNodeId: 'actor:secondary',
      });
      return { deletedCount: 1, status: 'merged' };
    },
    async upsertEdge(input) {
      assert.deepEqual(input, {
        fromGraphNodeId: 'node-a',
        projectId: 'project-a',
        properties: {},
        relationType: 'RELATED_TO',
        toGraphNodeId: 'node-b',
      });
    },
    async upsertNode(input) {
      assert.deepEqual(input, {
        graphNodeId: 'node-a',
        labels: ['Document'],
        projectId: 'project-a',
        properties: { documentId: 'document-a' },
      });
    },
  } satisfies GraphMutationRepository;

  await repository.ensureProjectGraph({ projectId: 'project-a' });
  await repository.upsertNode({
    graphNodeId: 'node-a',
    labels: ['Document'],
    projectId: 'project-a',
    properties: { documentId: 'document-a' },
  });
  assert.equal(
    await repository.deleteDocumentGraphNodes({
      graphNodeIds: ['document:email:msg-a'],
      projectId: 'project-a',
    }),
    1,
  );
});
