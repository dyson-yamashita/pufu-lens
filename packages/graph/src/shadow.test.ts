import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  GraphMutationRepository,
  GraphPresetReadResult,
  GraphReadRepository,
} from './index.js';
import {
  createGraphShadowMutationRepository,
  createGraphShadowReadRepository,
  GraphShadowMutationError,
  type GraphShadowObservation,
  parseGraphTransitionMode,
} from './shadow.js';

test('graph transition mode defaults to off and rejects unknown values', () => {
  assert.equal(parseGraphTransitionMode(undefined), 'off');
  assert.equal(parseGraphTransitionMode('  '), 'off');
  assert.equal(parseGraphTransitionMode('dual-write'), 'dual-write');
  assert.equal(parseGraphTransitionMode('dual-write-shadow-read'), 'dual-write-shadow-read');
  assert.throws(
    () => parseGraphTransitionMode('relational-primary'),
    /Invalid graph transition mode/,
  );
});

test('off mode reads only AGE and returns the identical primary value', async () => {
  const primaryResult = { candidates: [], status: 'success' as const };
  let shadowCalls = 0;
  const repository = createGraphShadowReadRepository({
    mode: 'off',
    primary: readRepository({ findRelatedDocuments: async () => primaryResult }),
    random: () => 0,
    shadow: readRepository({
      findRelatedDocuments: async () => {
        shadowCalls += 1;
        return { candidates: [], status: 'unavailable' };
      },
    }),
  });

  assert.equal(
    await repository.findRelatedDocuments({ projectId: 'private-project', seedDocumentIds: [] }),
    primaryResult,
  );
  assert.equal(shadowCalls, 0);
});

test('shadow read sampling boundary is fixed at ten percent', async () => {
  let shadowCalls = 0;
  const createRepository = (random: number) =>
    createGraphShadowReadRepository({
      mode: 'dual-write-shadow-read',
      primary: readRepository({ countDocumentNode: async () => 1 }),
      random: () => random,
      shadow: readRepository({
        countDocumentNode: async () => {
          shadowCalls += 1;
          return 1;
        },
      }),
    });

  await createRepository(0.099).countDocumentNode({
    graphNodeId: 'private-node',
    projectId: 'private-project',
  });
  await createRepository(0.1).countDocumentNode({
    graphNodeId: 'private-node',
    projectId: 'private-project',
  });
  assert.equal(shadowCalls, 1);
});

test('shadow mismatch returns primary and emits only sanitized allowlisted fields', async () => {
  const observations: GraphShadowObservation[] = [];
  const repository = createGraphShadowReadRepository({
    mode: 'dual-write-shadow-read',
    now: sequenceClock([10, 15, 20, 28]),
    observer: (observation) => {
      observations.push(observation);
    },
    primary: readRepository({ countDocumentNode: async () => 1 }),
    random: () => 0,
    shadow: readRepository({ countDocumentNode: async () => 2 }),
  });

  assert.equal(
    await repository.countDocumentNode({
      graphNodeId: 'do-not-log-node',
      projectId: 'do-not-log-project',
    }),
    1,
  );
  assert.deepEqual(observations, [
    {
      capability: 'read',
      event: 'graph_transition_observation',
      mismatchCategories: ['count'],
      operation: 'count_document_node',
      outcome: 'mismatch',
      primaryLatencyMs: 5,
      primaryProvider: 'postgres_age',
      shadowLatencyMs: 8,
      shadowProvider: 'postgres_relational',
    },
  ]);
  const serialized = JSON.stringify(observations);
  assert.doesNotMatch(serialized, /do-not-log|graphNodeId|projectId|properties|error|secret/i);
});

test('shadow timeout and errors preserve the primary result', async () => {
  const outcomes: string[] = [];
  const base = {
    mode: 'dual-write-shadow-read' as const,
    observer: (observation: GraphShadowObservation) => {
      outcomes.push(observation.outcome);
    },
    primary: readRepository({ countDocumentNode: async () => 7 }),
    random: () => 0,
  };
  const timeoutRepository = createGraphShadowReadRepository({
    ...base,
    cancelTimeout: () => undefined,
    scheduleTimeout: (callback) => {
      queueMicrotask(callback);
      return 1;
    },
    shadow: readRepository({ countDocumentNode: () => new Promise(() => undefined) }),
  });
  const errorRepository = createGraphShadowReadRepository({
    ...base,
    shadow: readRepository({ countDocumentNode: async () => Promise.reject(new Error('secret')) }),
  });

  assert.equal(
    await timeoutRepository.countDocumentNode({ graphNodeId: 'node', projectId: 'project' }),
    7,
  );
  assert.equal(
    await errorRepository.countDocumentNode({ graphNodeId: 'node', projectId: 'project' }),
    7,
  );
  assert.deepEqual(outcomes, ['shadow_timeout', 'shadow_error']);
});

test('preset comparison canonicalizes provider IDs and ignores values and compatibility rows', async () => {
  const observations: GraphShadowObservation[] = [];
  const primary = preset('age-node', 'age-edge', 'old-value', 'AGE preview');
  const shadow = preset('rel-node', 'rel-edge', 'new-value', 'relational preview');
  shadow.rawRows = [{ provider: 'different' }];
  shadow.rowCount = 99;
  const repository = createGraphShadowReadRepository({
    mode: 'dual-write-shadow-read',
    observer: (observation) => {
      observations.push(observation);
    },
    primary: readRepository({ readPreset: async () => primary }),
    random: () => 0,
    shadow: readRepository({ readPreset: async () => shadow }),
  });

  assert.equal(
    await repository.readPreset({
      documentGraphNodeIds: ['private'],
      presetId: 'recent-relations',
      projectId: 'private',
    }),
    primary,
  );
  assert.equal(observations[0]?.outcome, 'match');
});

test('preset identity drift does not create false label or property-key categories', async () => {
  const observations: GraphShadowObservation[] = [];
  const primary = preset('age-node', 'age-edge', 'value', 'preview');
  const shadow = {
    ...preset('rel-node', 'rel-edge', 'value', 'preview'),
    nodes: [
      {
        id: 'rel-node',
        label: 'Document',
        labels: ['Document'],
        properties: { graphNodeId: 'different-canonical-node', title: 'value' },
      },
    ],
  };
  const repository = createGraphShadowReadRepository({
    mode: 'dual-write-shadow-read',
    observer: (observation) => {
      observations.push(observation);
    },
    primary: readRepository({ readPreset: async () => primary }),
    random: () => 0,
    shadow: readRepository({ readPreset: async () => shadow }),
  });

  await repository.readPreset({
    documentGraphNodeIds: ['private'],
    presetId: 'recent-relations',
    projectId: 'private',
  });
  assert.deepEqual(observations[0]?.mismatchCategories, ['edge_identity', 'node_identity']);
});

test('preset comparison canonicalizes reverse SAME_AS endpoints by UTF-8 byte order', async () => {
  const observations: GraphShadowObservation[] = [];
  const primary = sameAsPreset({
    firstId: 'age-a',
    firstKey: `actor:${'\uE000'}`,
    secondId: 'age-b',
    secondKey: `actor:${'\u{10000}'}`,
    source: 'age-b',
    target: 'age-a',
  });
  const shadow = sameAsPreset({
    firstId: 'rel-a',
    firstKey: `actor:${'\uE000'}`,
    secondId: 'rel-b',
    secondKey: `actor:${'\u{10000}'}`,
    source: 'rel-a',
    target: 'rel-b',
  });
  const repository = createGraphShadowReadRepository({
    mode: 'dual-write-shadow-read',
    observer: (observation) => {
      observations.push(observation);
    },
    primary: readRepository({ readPreset: async () => primary }),
    random: () => 0,
    shadow: readRepository({ readPreset: async () => shadow }),
  });

  await repository.readPreset({
    documentGraphNodeIds: ['private'],
    presetId: 'recent-relations',
    projectId: 'private',
  });
  assert.equal(observations[0]?.outcome, 'match');
});

test('relation counts and related candidates emit finite mismatch categories only', async () => {
  const observations: GraphShadowObservation[] = [];
  const repository = createGraphShadowReadRepository({
    mode: 'dual-write-shadow-read',
    observer: (observation) => {
      observations.push(observation);
    },
    primary: readRepository({
      countRelations: async () => ({ MENTIONS: 1 }),
      findRelatedDocuments: async () => ({
        candidates: [
          {
            documentId: 'primary-private-document',
            hopCount: 1,
            relationType: 'MENTIONS',
            seedDocumentId: 'private-seed',
          },
        ],
        status: 'success',
      }),
    }),
    random: () => 0,
    shadow: readRepository({
      countRelations: async () => ({ MENTIONS: 2 }),
      findRelatedDocuments: async () => ({ candidates: [], status: 'unavailable' }),
    }),
  });

  await repository.countRelations({
    graphNodeId: 'private-node',
    projectId: 'private-project',
    relationTypes: ['MENTIONS'],
  });
  await repository.findRelatedDocuments({
    projectId: 'private-project',
    seedDocumentIds: ['private-seed'],
  });
  assert.deepEqual(
    observations.map(({ mismatchCategories, operation }) => ({ mismatchCategories, operation })),
    [
      { mismatchCategories: ['relation_counts'], operation: 'count_relations' },
      {
        mismatchCategories: ['candidate_set', 'status'],
        operation: 'find_related_documents',
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(observations), /primary-private|private-seed|private-project/);
});

test('dual-write calls AGE before relational and propagates a sanitized shadow error', async () => {
  const calls: string[] = [];
  const observations: GraphShadowObservation[] = [];
  const repository = createGraphShadowMutationRepository({
    mode: 'dual-write',
    observer: (observation) => {
      observations.push(observation);
    },
    primary: mutationRepository({ upsertNode: async () => void calls.push('primary') }),
    shadow: mutationRepository({
      upsertNode: async () => {
        calls.push('shadow');
        throw new Error('database secret');
      },
    }),
  });

  await assert.rejects(
    () =>
      repository.upsertNode({
        graphNodeId: 'private-node',
        labels: ['Document'],
        projectId: 'private-project',
        properties: { secret: 'never-log' },
      }),
    (error: unknown) => error instanceof GraphShadowMutationError,
  );
  assert.deepEqual(calls, ['primary', 'shadow']);
  assert.equal(observations[0]?.outcome, 'shadow_error');
  assert.doesNotMatch(JSON.stringify(observations), /private|never-log|database secret/i);
});

test('document cleanup is fail-open while actor merge mismatch is retryable failure', async () => {
  const cleanup = createGraphShadowMutationRepository({
    mode: 'dual-write',
    primary: mutationRepository({ deleteDocumentGraphNodes: async () => 2 }),
    shadow: mutationRepository({
      deleteDocumentGraphNodes: async () => Promise.reject(new Error('unavailable')),
    }),
  });
  assert.equal(
    await cleanup.deleteDocumentGraphNodes({ graphNodeIds: ['node'], projectId: 'project' }),
    2,
  );

  const merge = createGraphShadowMutationRepository({
    mode: 'dual-write',
    primary: mutationRepository({
      mergeActorGraphNodes: async () => ({ deletedCount: 1, status: 'merged' }),
    }),
    shadow: mutationRepository({
      mergeActorGraphNodes: async () => ({ reason: 'missing', status: 'skipped' }),
    }),
  });
  await assert.rejects(
    () =>
      merge.mergeActorGraphNodes({
        primaryActorId: 'actor',
        primaryGraphNodeId: 'primary',
        projectId: 'project',
        secondaryGraphNodeId: 'secondary',
      }),
    GraphShadowMutationError,
  );
});

test('observer failures never alter successful primary read or mutation behavior', async () => {
  const observer = () => Promise.reject(new Error('observer failed'));
  const read = createGraphShadowReadRepository({
    mode: 'dual-write-shadow-read',
    observer,
    primary: readRepository({ countDocumentNode: async () => 1 }),
    random: () => 0,
    shadow: readRepository({ countDocumentNode: async () => 1 }),
  });
  assert.equal(await read.countDocumentNode({ graphNodeId: 'node', projectId: 'project' }), 1);
  const mutation = createGraphShadowMutationRepository({
    mode: 'dual-write',
    observer,
    primary: mutationRepository({}),
    random: () => 0,
    shadow: mutationRepository({}),
  });
  await mutation.ensureProjectGraph({ projectId: 'project' });
});

test('successful mutation observation sampling is fixed at one percent', async () => {
  const observations: GraphShadowObservation[] = [];
  const createRepository = (random: number) =>
    createGraphShadowMutationRepository({
      mode: 'dual-write',
      observer: (observation) => {
        observations.push(observation);
      },
      primary: mutationRepository({}),
      random: () => random,
      shadow: mutationRepository({}),
    });

  await createRepository(0.009).ensureProjectGraph({ projectId: 'private-project' });
  await createRepository(0.01).ensureProjectGraph({ projectId: 'private-project' });
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.outcome, 'match');
});

test('primary read errors and unavailable actor merges never invoke a shadow provider', async () => {
  let readShadowCalls = 0;
  const read = createGraphShadowReadRepository({
    mode: 'dual-write-shadow-read',
    primary: readRepository({
      countDocumentNode: async () => Promise.reject(new Error('primary unavailable')),
    }),
    random: () => 0,
    shadow: readRepository({
      countDocumentNode: async () => {
        readShadowCalls += 1;
        return 0;
      },
    }),
  });
  await assert.rejects(
    () => read.countDocumentNode({ graphNodeId: 'node', projectId: 'project' }),
    /primary unavailable/,
  );
  assert.equal(readShadowCalls, 0);

  let mergeShadowCalls = 0;
  const mutation = createGraphShadowMutationRepository({
    mode: 'dual-write',
    primary: mutationRepository({
      mergeActorGraphNodes: async () => ({ status: 'unavailable' }),
    }),
    shadow: mutationRepository({
      mergeActorGraphNodes: async () => {
        mergeShadowCalls += 1;
        return { deletedCount: 1, status: 'merged' };
      },
    }),
  });
  assert.deepEqual(
    await mutation.mergeActorGraphNodes({
      primaryActorId: 'actor',
      primaryGraphNodeId: 'primary',
      projectId: 'project',
      secondaryGraphNodeId: 'secondary',
    }),
    { status: 'unavailable' },
  );
  assert.equal(mergeShadowCalls, 0);
});

function readRepository(overrides: Partial<GraphReadRepository>): GraphReadRepository {
  return {
    countDocumentNode: async () => 0,
    countRelations: async () => ({}),
    findRelatedDocuments: async () => ({ candidates: [], status: 'success' }),
    readPreset: async () => preset('node', 'edge', 'value', 'preview'),
    ...overrides,
  };
}

function mutationRepository(overrides: Partial<GraphMutationRepository>): GraphMutationRepository {
  return {
    deleteDocumentGraphNodes: async () => 0,
    deleteProjectGraph: async () => undefined,
    ensureProjectGraph: async () => undefined,
    mergeActorGraphNodes: async () => ({ deletedCount: 1, status: 'merged' }),
    upsertEdge: async () => undefined,
    upsertNode: async () => undefined,
    ...overrides,
  };
}

function preset(
  nodeId: string,
  edgeId: string,
  propertyValue: string,
  preview: string,
): GraphPresetReadResult & { rawRows: Record<string, unknown>[]; rowCount: number } {
  return {
    edges: [
      {
        id: edgeId,
        label: 'MENTIONS',
        properties: { weight: propertyValue },
        source: nodeId,
        target: nodeId,
      },
    ],
    nodes: [
      {
        id: nodeId,
        label: 'Document',
        labels: ['Document'],
        properties: { graphNodeId: 'canonical-node', title: propertyValue },
      },
    ],
    preview,
    rawRows: [],
    rowCount: 1,
    truncated: false,
  };
}

function sameAsPreset(input: {
  readonly firstId: string;
  readonly firstKey: string;
  readonly secondId: string;
  readonly secondKey: string;
  readonly source: string;
  readonly target: string;
}): GraphPresetReadResult {
  return {
    edges: [
      {
        id: 'provider-edge',
        label: 'SAME_AS',
        properties: {},
        source: input.source,
        target: input.target,
      },
    ],
    nodes: [
      {
        id: input.firstId,
        label: 'Actor',
        labels: ['Actor'],
        properties: { graphNodeId: input.firstKey },
      },
      {
        id: input.secondId,
        label: 'Actor',
        labels: ['Actor'],
        properties: { graphNodeId: input.secondKey },
      },
    ],
    preview: 'provider preview',
    rawRows: [],
    rowCount: 1,
    truncated: false,
  };
}

function sequenceClock(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
