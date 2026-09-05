import { Buffer } from 'node:buffer';
import type {
  GraphActorMergeResult,
  GraphMutationRepository,
  GraphPresetReadResult,
  GraphReadRepository,
  GraphRelatedDocumentReadResult,
  GraphRelationType,
} from './index.js';

/** Server-owned migration profile for the AGE to relational graph transition. */
export type GraphTransitionMode = 'off' | 'dual-write' | 'dual-write-shadow-read';

/** Read and mutation operations that can emit sanitized transition observations. */
export type GraphShadowOperation =
  | 'count_document_node'
  | 'count_relations'
  | 'delete_document_graph_nodes'
  | 'delete_project_graph'
  | 'ensure_project_graph'
  | 'find_related_documents'
  | 'merge_actor_graph_nodes'
  | 'read_preset'
  | 'upsert_edge'
  | 'upsert_node';

/** Finite mismatch buckets that never contain graph or document identities. */
export type GraphShadowMismatchCategory =
  | 'candidate_set'
  | 'count'
  | 'edge_count'
  | 'edge_identity'
  | 'labels'
  | 'mutation_result'
  | 'node_count'
  | 'node_identity'
  | 'property_keys'
  | 'relation_counts'
  | 'status'
  | 'truncated';

/** Allowlisted, identity-free observation emitted by graph transition wrappers. */
export interface GraphShadowObservation {
  readonly capability: 'mutation' | 'read';
  readonly event: 'graph_transition_observation';
  readonly mismatchCategories: readonly GraphShadowMismatchCategory[];
  readonly operation: GraphShadowOperation;
  readonly outcome: 'match' | 'mismatch' | 'shadow_error' | 'shadow_timeout';
  readonly primaryLatencyMs: number;
  readonly primaryProvider: 'postgres_age';
  readonly shadowLatencyMs: number;
  readonly shadowProvider: 'postgres_relational';
}

/** Receives a sanitized graph transition observation. */
export type GraphShadowObserver = (observation: GraphShadowObservation) => Promise<void> | void;

interface GraphShadowRuntimeOptions {
  readonly now?: () => number;
  readonly observer?: GraphShadowObserver;
  readonly random?: () => number;
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimeout?: (handle: unknown) => void;
}

export interface GraphShadowReadOptions extends GraphShadowRuntimeOptions {
  readonly mode: GraphTransitionMode;
  readonly primary: GraphReadRepository;
  readonly shadow: GraphReadRepository;
}

export interface GraphShadowMutationOptions extends GraphShadowRuntimeOptions {
  readonly mode: GraphTransitionMode;
  readonly primary: GraphMutationRepository;
  readonly shadow: GraphMutationRepository;
}

/** Fixed sampling rate for successful relational shadow reads. */
export const GRAPH_SHADOW_READ_SAMPLE_RATE = 0.1;
/** Fixed sampling rate for successful dual-write observations. */
export const GRAPH_SHADOW_MUTATION_SUCCESS_SAMPLE_RATE = 0.01;
/** Outer deadline for relational shadow reads; adapters retain their own shorter SQL timeout. */
export const GRAPH_SHADOW_READ_TIMEOUT_MS = 6_000;

/** Fixed error returned when a retryable relational shadow mutation cannot be committed. */
export class GraphShadowMutationError extends Error {
  constructor() {
    super('Graph shadow mutation failed.');
    this.name = 'GraphShadowMutationError';
  }
}

/** Parses the deployment-level transition profile, defaulting to AGE-only behavior. */
export function parseGraphTransitionMode(value: string | undefined): GraphTransitionMode {
  const normalized = value?.trim();
  if (!normalized) {
    return 'off';
  }
  if (normalized === 'dual-write' || normalized === 'dual-write-shadow-read') {
    return normalized;
  }
  if (normalized === 'off') {
    return 'off';
  }
  throw new Error('Invalid graph transition mode.');
}

/** Creates an AGE-primary reader with optional sampled relational shadow comparison. */
export function createGraphShadowReadRepository(
  options: GraphShadowReadOptions,
): GraphReadRepository {
  const runtime = createRuntime(options);
  return {
    async countDocumentNode(input) {
      return executeShadowRead(
        options,
        runtime,
        'count_document_node',
        () => options.primary.countDocumentNode(input),
        () => options.shadow.countDocumentNode(input),
        compareCount,
      );
    },
    async countRelations(input) {
      return executeShadowRead(
        options,
        runtime,
        'count_relations',
        () => options.primary.countRelations(input),
        () => options.shadow.countRelations(input),
        compareRelationCounts,
      );
    },
    async findRelatedDocuments(input) {
      return executeShadowRead(
        options,
        runtime,
        'find_related_documents',
        () => options.primary.findRelatedDocuments(input),
        () => options.shadow.findRelatedDocuments(input),
        compareRelatedDocuments,
      );
    },
    async readPreset(input) {
      return executeShadowRead(
        options,
        runtime,
        'read_preset',
        () => options.primary.readPreset(input),
        () => options.shadow.readPreset(input),
        comparePreset,
      );
    },
  };
}

/** Creates an AGE-primary mutation repository with optional relational dual-write. */
export function createGraphShadowMutationRepository(
  options: GraphShadowMutationOptions,
): GraphMutationRepository {
  const runtime = createRuntime(options);
  return {
    async deleteDocumentGraphNodes(input) {
      const primaryStart = runtime.now();
      const primaryResult = await options.primary.deleteDocumentGraphNodes(input);
      const primaryLatencyMs = elapsed(runtime, primaryStart);
      if (options.mode === 'off') {
        return primaryResult;
      }
      const shadowStart = runtime.now();
      try {
        const shadowResult = await options.shadow.deleteDocumentGraphNodes(input);
        const categories: GraphShadowMismatchCategory[] =
          primaryResult === shadowResult ? [] : ['count'];
        await observe(
          runtime,
          mutationObservation(
            'delete_document_graph_nodes',
            categories.length === 0 ? 'match' : 'mismatch',
            categories,
            primaryLatencyMs,
            elapsed(runtime, shadowStart),
          ),
          categories.length > 0,
        );
        if (categories.length > 0) {
          throw new GraphShadowMutationError();
        }
      } catch (error) {
        if (error instanceof GraphShadowMutationError) {
          throw error;
        }
        await observe(
          runtime,
          mutationObservation(
            'delete_document_graph_nodes',
            'shadow_error',
            [],
            primaryLatencyMs,
            elapsed(runtime, shadowStart),
          ),
          true,
        );
        throw new GraphShadowMutationError();
      }
      return primaryResult;
    },
    async deleteProjectGraph(input) {
      return executeVoidMutation(
        options,
        runtime,
        'delete_project_graph',
        () => options.primary.deleteProjectGraph(input),
        () => options.shadow.deleteProjectGraph(input),
      );
    },
    async ensureProjectGraph(input) {
      return executeVoidMutation(
        options,
        runtime,
        'ensure_project_graph',
        () => options.primary.ensureProjectGraph(input),
        () => options.shadow.ensureProjectGraph(input),
      );
    },
    async mergeActorGraphNodes(input) {
      const primaryStart = runtime.now();
      const primaryResult = await options.primary.mergeActorGraphNodes(input);
      const primaryLatencyMs = elapsed(runtime, primaryStart);
      if (options.mode === 'off' || primaryResult.status === 'unavailable') {
        return primaryResult;
      }
      const shadowStart = runtime.now();
      try {
        const shadowResult = await options.shadow.mergeActorGraphNodes(input);
        if (!equalActorMergeResult(primaryResult, shadowResult)) {
          await observe(
            runtime,
            mutationObservation(
              'merge_actor_graph_nodes',
              'mismatch',
              ['mutation_result'],
              primaryLatencyMs,
              elapsed(runtime, shadowStart),
            ),
            true,
          );
          throw new GraphShadowMutationError();
        }
        await observe(
          runtime,
          mutationObservation(
            'merge_actor_graph_nodes',
            'match',
            [],
            primaryLatencyMs,
            elapsed(runtime, shadowStart),
          ),
          false,
        );
        return primaryResult;
      } catch (error) {
        if (error instanceof GraphShadowMutationError) {
          throw error;
        }
        await observe(
          runtime,
          mutationObservation(
            'merge_actor_graph_nodes',
            'shadow_error',
            [],
            primaryLatencyMs,
            elapsed(runtime, shadowStart),
          ),
          true,
        );
        throw new GraphShadowMutationError();
      }
    },
    async upsertEdge(input) {
      return executeVoidMutation(
        options,
        runtime,
        'upsert_edge',
        () => options.primary.upsertEdge(input),
        () => options.shadow.upsertEdge(input),
      );
    },
    async upsertNode(input) {
      return executeVoidMutation(
        options,
        runtime,
        'upsert_node',
        () => options.primary.upsertNode(input),
        () => options.shadow.upsertNode(input),
      );
    },
  };
}

interface Runtime {
  readonly cancelTimeout: (handle: unknown) => void;
  readonly now: () => number;
  readonly observer?: GraphShadowObserver;
  readonly random: () => number;
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
}

interface Comparison {
  readonly categories: readonly GraphShadowMismatchCategory[];
}

function createRuntime(options: GraphShadowRuntimeOptions): Runtime {
  return {
    cancelTimeout:
      options.cancelTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    now: options.now ?? Date.now,
    observer: options.observer,
    random: options.random ?? Math.random,
    scheduleTimeout:
      options.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
  };
}

async function executeShadowRead<T>(
  options: Pick<GraphShadowReadOptions, 'mode'>,
  runtime: Runtime,
  operation: GraphShadowOperation,
  readPrimary: () => Promise<T>,
  readShadow: () => Promise<T>,
  compare: (primary: T, shadow: T) => Comparison,
): Promise<T> {
  const primaryStart = runtime.now();
  const primaryResult = await readPrimary();
  const primaryLatencyMs = elapsed(runtime, primaryStart);
  if (
    options.mode !== 'dual-write-shadow-read' ||
    runtime.random() >= GRAPH_SHADOW_READ_SAMPLE_RATE
  ) {
    return primaryResult;
  }

  const shadowStart = runtime.now();
  try {
    const shadowResult = await withTimeout(readShadow(), runtime);
    const { categories } = compare(primaryResult, shadowResult);
    await observe(
      runtime,
      readObservation(
        operation,
        categories.length === 0 ? 'match' : 'mismatch',
        categories,
        primaryLatencyMs,
        elapsed(runtime, shadowStart),
      ),
      true,
    );
  } catch (error) {
    await observe(
      runtime,
      readObservation(
        operation,
        error instanceof ShadowTimeoutError ? 'shadow_timeout' : 'shadow_error',
        [],
        primaryLatencyMs,
        elapsed(runtime, shadowStart),
      ),
      true,
    );
  }
  return primaryResult;
}

async function executeVoidMutation(
  options: Pick<GraphShadowMutationOptions, 'mode'>,
  runtime: Runtime,
  operation: GraphShadowOperation,
  mutatePrimary: () => Promise<void>,
  mutateShadow: () => Promise<void>,
): Promise<void> {
  const primaryStart = runtime.now();
  await mutatePrimary();
  const primaryLatencyMs = elapsed(runtime, primaryStart);
  if (options.mode === 'off') {
    return;
  }
  const shadowStart = runtime.now();
  try {
    await mutateShadow();
    await observe(
      runtime,
      mutationObservation(operation, 'match', [], primaryLatencyMs, elapsed(runtime, shadowStart)),
      false,
    );
  } catch {
    await observe(
      runtime,
      mutationObservation(
        operation,
        'shadow_error',
        [],
        primaryLatencyMs,
        elapsed(runtime, shadowStart),
      ),
      true,
    );
    throw new GraphShadowMutationError();
  }
}

class ShadowTimeoutError extends Error {}

async function withTimeout<T>(operation: Promise<T>, runtime: Runtime): Promise<T> {
  let handle: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = runtime.scheduleTimeout(
      () => reject(new ShadowTimeoutError()),
      GRAPH_SHADOW_READ_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    runtime.cancelTimeout(handle);
  }
}

function elapsed(runtime: Runtime, startedAt: number): number {
  return Math.max(0, Math.round(runtime.now() - startedAt));
}

async function observe(
  runtime: Runtime,
  observation: GraphShadowObservation,
  always: boolean,
): Promise<void> {
  if (!runtime.observer) {
    return;
  }
  if (!always && runtime.random() >= GRAPH_SHADOW_MUTATION_SUCCESS_SAMPLE_RATE) {
    return;
  }
  try {
    await runtime.observer(observation);
  } catch {
    // Observability must never change primary graph behavior.
  }
}

function readObservation(
  operation: GraphShadowOperation,
  outcome: GraphShadowObservation['outcome'],
  mismatchCategories: readonly GraphShadowMismatchCategory[],
  primaryLatencyMs: number,
  shadowLatencyMs: number,
): GraphShadowObservation {
  return observation(
    'read',
    operation,
    outcome,
    mismatchCategories,
    primaryLatencyMs,
    shadowLatencyMs,
  );
}

function mutationObservation(
  operation: GraphShadowOperation,
  outcome: GraphShadowObservation['outcome'],
  mismatchCategories: readonly GraphShadowMismatchCategory[],
  primaryLatencyMs: number,
  shadowLatencyMs: number,
): GraphShadowObservation {
  return observation(
    'mutation',
    operation,
    outcome,
    mismatchCategories,
    primaryLatencyMs,
    shadowLatencyMs,
  );
}

function observation(
  capability: GraphShadowObservation['capability'],
  operation: GraphShadowOperation,
  outcome: GraphShadowObservation['outcome'],
  mismatchCategories: readonly GraphShadowMismatchCategory[],
  primaryLatencyMs: number,
  shadowLatencyMs: number,
): GraphShadowObservation {
  return {
    capability,
    event: 'graph_transition_observation',
    mismatchCategories: [...new Set(mismatchCategories)].sort(),
    operation,
    outcome,
    primaryLatencyMs,
    primaryProvider: 'postgres_age',
    shadowLatencyMs,
    shadowProvider: 'postgres_relational',
  };
}

function compareCount(primary: number, shadow: number): Comparison {
  return { categories: primary === shadow ? [] : ['count'] };
}

function compareRelationCounts(
  primary: Readonly<Partial<Record<GraphRelationType, number>>>,
  shadow: Readonly<Partial<Record<GraphRelationType, number>>>,
): Comparison {
  const keys = [...new Set([...Object.keys(primary), ...Object.keys(shadow)])].sort();
  const matches = keys.every(
    (key) => (primary[key as GraphRelationType] ?? 0) === (shadow[key as GraphRelationType] ?? 0),
  );
  return { categories: matches ? [] : ['relation_counts'] };
}

function compareRelatedDocuments(
  primary: GraphRelatedDocumentReadResult,
  shadow: GraphRelatedDocumentReadResult,
): Comparison {
  const categories: GraphShadowMismatchCategory[] = [];
  if (primary.status !== shadow.status) {
    categories.push('status');
  }
  const serialize = (result: GraphRelatedDocumentReadResult): string[] =>
    result.candidates
      .map((candidate) =>
        JSON.stringify([
          candidate.documentId,
          candidate.hopCount,
          candidate.relationType,
          candidate.seedDocumentId,
        ]),
      )
      .sort();
  if (!equalStringArrays(serialize(primary), serialize(shadow))) {
    categories.push('candidate_set');
  }
  return { categories };
}

function comparePreset(primary: GraphPresetReadResult, shadow: GraphPresetReadResult): Comparison {
  const categories: GraphShadowMismatchCategory[] = [];
  if (primary.nodes.length !== shadow.nodes.length) {
    categories.push('node_count');
  }
  if (primary.edges.length !== shadow.edges.length) {
    categories.push('edge_count');
  }
  if (primary.truncated !== shadow.truncated) {
    categories.push('truncated');
  }
  const primaryCanonical = canonicalPreset(primary);
  const shadowCanonical = canonicalPreset(shadow);
  if (!equalStringArrays(primaryCanonical.nodeIdentities, shadowCanonical.nodeIdentities)) {
    categories.push('node_identity');
  }
  if (!equalStringArrays(primaryCanonical.edgeIdentities, shadowCanonical.edgeIdentities)) {
    categories.push('edge_identity');
  }
  if (sharedMapValueMismatch(primaryCanonical.labels, shadowCanonical.labels)) {
    categories.push('labels');
  }
  if (sharedMapValueMismatch(primaryCanonical.propertyKeys, shadowCanonical.propertyKeys)) {
    categories.push('property_keys');
  }
  return { categories };
}

function canonicalPreset(result: GraphPresetReadResult): {
  readonly edgeIdentities: string[];
  readonly labels: ReadonlyMap<string, string>;
  readonly nodeIdentities: string[];
  readonly propertyKeys: ReadonlyMap<string, string>;
} {
  const idToNodeKey = new Map<string, string>();
  const nodeIdentities: string[] = [];
  const labels = new Map<string, string>();
  const propertyKeys = new Map<string, string>();
  for (const node of result.nodes) {
    const graphNodeId =
      typeof node.properties.graphNodeId === 'string'
        ? node.properties.graphNodeId
        : `invalid:${node.id}`;
    idToNodeKey.set(node.id, graphNodeId);
    nodeIdentities.push(graphNodeId);
    labels.set(graphNodeId, JSON.stringify([node.label, [...node.labels].sort()]));
    propertyKeys.set(`node:${graphNodeId}`, JSON.stringify(Object.keys(node.properties).sort()));
  }
  const edgeIdentities: string[] = [];
  for (const edge of result.edges) {
    const mappedSource = idToNodeKey.get(edge.source) ?? `invalid:${edge.source}`;
    const mappedTarget = idToNodeKey.get(edge.target) ?? `invalid:${edge.target}`;
    const [source, target] =
      edge.label === 'SAME_AS' && compareUtf8ByteOrder(mappedSource, mappedTarget) > 0
        ? [mappedTarget, mappedSource]
        : [mappedSource, mappedTarget];
    const edgeIdentity = JSON.stringify([source, edge.label, target]);
    edgeIdentities.push(edgeIdentity);
    propertyKeys.set(`edge:${edgeIdentity}`, JSON.stringify(Object.keys(edge.properties).sort()));
  }
  return {
    edgeIdentities: edgeIdentities.sort(),
    labels,
    nodeIdentities: nodeIdentities.sort(),
    propertyKeys,
  };
}

function equalActorMergeResult(
  primary: GraphActorMergeResult,
  shadow: GraphActorMergeResult,
): boolean {
  return JSON.stringify(primary) === JSON.stringify(shadow);
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sharedMapValueMismatch(
  primary: ReadonlyMap<string, string>,
  shadow: ReadonlyMap<string, string>,
): boolean {
  for (const [identity, primaryValue] of primary) {
    const shadowValue = shadow.get(identity);
    if (shadowValue !== undefined && shadowValue !== primaryValue) {
      return true;
    }
  }
  return false;
}

function compareUtf8ByteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
