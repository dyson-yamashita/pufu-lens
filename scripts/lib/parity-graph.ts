import { isDeepStrictEqual } from 'node:util';
import type { GraphMutationRepository, GraphReadRepository } from '@pufu-lens/graph';
import { parseGraphMutationEdgeInput, parseGraphRelatedDocumentCandidate } from '@pufu-lens/graph';
import type { ParityRow } from './parity-eval.ts';
import { parityFixture } from './parity-fixture.ts';

type Tuple = ParityRow['graph'][number];
const ordered = (tuples: readonly (readonly [string, string, string, string, number])[]) =>
  [...tuples].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export interface GraphState {
  graph: Tuple[];
  // Stable persisted fields, including properties; excludes backend clocks.
  records: unknown[];
}
export interface ParityGraphBackend {
  mutation: GraphMutationRepository;
  read: Pick<GraphReadRepository, 'findRelatedDocuments'>;
  snapshot(projectId: string): Promise<GraphState>;
}

/** Validates persisted SQL fields before canonicalizing; unknown projects remain visible failures. */
export function parseGraphState(nodes: readonly unknown[], edges: readonly unknown[]): GraphState {
  const graph: Tuple[] = [];
  const records: unknown[] = [];
  for (const [kind, rows] of [
    ['node', nodes],
    ['edge', edges],
  ] as const) {
    for (const value of rows) {
      if (!value || typeof value !== 'object') throw new Error('Invalid graph snapshot row');
      const row = value as Record<string, unknown>;
      const text = (key: string) => {
        const field = row[key];
        if (typeof field !== 'string' || !field) throw new Error('Invalid graph snapshot field');
        return field;
      };
      const project = text('project_id');
      const properties: unknown =
        typeof row.properties === 'string' ? JSON.parse(row.properties) : row.properties;
      if (!properties || typeof properties !== 'object' || Array.isArray(properties))
        throw new Error('Invalid graph snapshot properties');
      if (kind === 'node') {
        const key = text('node_key');
        const nodeKind = text('kind');
        if (
          !['document', 'actor', 'topic'].includes(nodeKind) ||
          !(row.subtype === null || typeof row.subtype === 'string')
        )
          throw new Error('Invalid graph snapshot node');
        graph.push([project, key, 'NODE', key, 0]);
        records.push([project, key, nodeKind, row.subtype, properties]);
      } else {
        const tuple: Tuple = [
          project,
          text('source_node_key'),
          text('relation_type'),
          text('target_node_key'),
          1,
        ];
        graph.push(tuple);
        records.push([...tuple, properties]);
      }
    }
  }
  graph.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  records.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { graph, records };
}

/** Executes only Graph cases from immutable input, reading every result from real adapters/DB.
 * Replays mutations and compares full persisted fields; sentinel uses colliding keys in another tenant.
 * Does not use fixture expected graphs to manufacture observations or claim HTTP authorization.
 */
export async function collectGraphParity(backend: ParityGraphBackend) {
  const { mutation, read, snapshot } = backend;
  const rows: ParityRow[] = [];
  const observations = [];
  const node = (projectId: string, graphNodeId: string) =>
    mutation.upsertNode({
      projectId,
      graphNodeId,
      labels: [graphNodeId.startsWith('actor:') ? 'Actor' : 'Document'],
      properties: graphNodeId.startsWith('actor:')
        ? { actorId: graphNodeId }
        : { documentId: graphNodeId, docType: 'web_page' },
    });
  const edge = (
    projectId: string,
    fromGraphNodeId: string,
    relationType: string,
    toGraphNodeId: string,
  ) =>
    mutation.upsertEdge(
      parseGraphMutationEdgeInput({
        projectId,
        fromGraphNodeId,
        toGraphNodeId,
        relationType,
        properties: {},
      }),
    );
  for (const test of parityFixture.cases.filter(
    (c) => c.kind === 'graph' || c.kind === 'mutation',
  )) {
    const started = performance.now();
    for (const projectId of ['alpha', 'beta']) {
      await mutation.deleteProjectGraph({ projectId });
      await mutation.ensureProjectGraph({ projectId });
    }
    for (const id of ['d01', 'd02', 'actor:a', 'actor:b', 'sentinel']) await node('beta', id);
    await edge('beta', 'd01', 'RELATED_TO', 'sentinel');
    await edge('beta', 'actor:b', 'AUTHORED', 'd02');
    const sentinelBefore = await snapshot('beta');
    const sentinelPresent = isDeepStrictEqual(
      sentinelBefore.graph,
      ordered([
        ...['d01', 'd02', 'actor:a', 'actor:b', 'sentinel'].map(
          (id): Tuple => ['beta', id, 'NODE', id, 0],
        ),
        ['beta', 'd01', 'RELATED_TO', 'sentinel', 1],
        ['beta', 'actor:b', 'AUTHORED', 'd02', 1],
      ]),
    );
    const input = test.graphInput ?? [];
    const seed = async () => {
      const ids = new Set(input.flatMap((t) => [t[1], t[3]]));
      for (const id of ids) await node(test.projectId, id);
      for (const [, source, relation, target] of input)
        if (relation !== 'NODE') await edge(test.projectId, source, relation, target);
    };
    await seed();
    const before = await snapshot(test.projectId);
    const inputObserved = isDeepStrictEqual(
      before.graph,
      ordered([
        ...[...new Set(input.flatMap((t) => [t[1], t[3]]))].map(
          (id): Tuple => [test.projectId, id, 'NODE', id, 0],
        ),
        ...input.filter((t) => t[2] !== 'NODE'),
      ]),
    );
    let graph: Tuple[];
    let mutationPass: boolean;
    let retryStable: boolean | null = null;
    if (test.kind === 'graph') {
      const relation = test.id.slice('graph-'.length);
      const result = await read.findRelatedDocuments({
        projectId: test.projectId,
        seedDocumentIds: ['d01', 'd01'],
        relationLimits: {
          SAME_AS: relation === 'SAME_AS' ? 1 : 0,
          RELATED_TO: relation === 'RELATED_TO' ? 1 : 0,
          MENTIONS: relation === 'MENTIONS' ? 1 : 0,
        },
      });
      if (result.status !== 'success') throw new Error('Local graph read unavailable');
      graph = result.candidates.map((value) => {
        const c = parseGraphRelatedDocumentCandidate(value);
        return [test.projectId, c.seedDocumentId, c.relationType, c.documentId, c.hopCount];
      });
      mutationPass = inputObserved && isDeepStrictEqual(before, await snapshot(test.projectId));
    } else {
      const operation = async () => {
        if (test.category === 'cleanup' || test.category === 'orphan') {
          await mutation.deleteDocumentGraphNodes({
            projectId: test.projectId,
            graphNodeIds: test.category === 'cleanup' ? ['d02'] : ['d01', 'd02'],
          });
        } else if (test.category === 'merge') {
          const result = await mutation.mergeActorGraphNodes({
            projectId: test.projectId,
            primaryActorId: 'actor:a',
            primaryGraphNodeId: 'actor:a',
            secondaryGraphNodeId: 'actor:b',
          });
          if (result.status === 'unavailable') throw new Error('Local graph merge unavailable');
        } else if (test.category === 'edge-types') {
          await node(test.projectId, 'd01');
          await node(test.projectId, 'd02');
          await edge(test.projectId, 'd01', test.query, 'd02');
        } else if (test.category === 'duplicate' || test.category === 'retry') await seed();
        else throw new Error('Unsupported graph mutation');
      };
      await operation();
      const after = await snapshot(test.projectId);
      await operation();
      const retried = await snapshot(test.projectId);
      retryStable = isDeepStrictEqual(after, retried);
      graph = retried.graph;
      // Expected values are used only to judge measured output, never as the output itself.
      mutationPass = inputObserved && retryStable && isDeepStrictEqual(graph, ordered(test.graph));
    }
    const foreignRead = await read.findRelatedDocuments({
      projectId: test.projectId,
      seedDocumentIds: ['sentinel'],
    });
    const foreignSeedRejected =
      foreignRead.status === 'success' && foreignRead.candidates.length === 0;
    const sentinelUnchanged = isDeepStrictEqual(sentinelBefore, await snapshot('beta'));
    const scopePass =
      sentinelPresent &&
      foreignSeedRejected &&
      sentinelUnchanged &&
      graph.every(
        ([project, source, , target]) =>
          project === test.projectId &&
          [source, target].every((id) =>
            parityFixture.graphNodes.some((n) => n.id === id && n.projectId === project),
          ),
      );
    rows.push({
      id: test.id,
      status: 'ok',
      error: null,
      chunkIds: [],
      finalDocumentIds: [],
      citationDocumentIds: [],
      tools: [],
      graph,
      scopePass,
      mutationPass,
      rubricPass: null,
      criticalErrors: 0,
    });
    observations.push({
      id: test.id,
      inputObserved,
      sentinelPresent,
      sentinelUnchanged,
      foreignSeedRejected,
      retryStable,
      before: before.graph,
      after: (await snapshot(test.projectId)).graph,
      latencyMs: [performance.now() - started],
    });
  }
  return { rows, observations };
}
