/** Related-document relation types supported by bounded graph coverage. */
export const GRAPH_RELATED_RELATION_TYPES = ['MENTIONS', 'RELATED_TO', 'SAME_AS'] as const;
/** Existing per-relation candidate pools owned by Pufu Lens graph coverage policy. */
export const GRAPH_RELATED_DOCUMENT_POOL_LIMITS = {
  MENTIONS: 5,
  RELATED_TO: 5,
  SAME_AS: 2,
} as const satisfies Record<GraphRelatedRelationType, number>;
/** Canonical graph relation allowlist shared by read and future mutation capabilities. */
export const GRAPH_RELATION_TYPES = [
  'AUTHORED',
  'COMMENTED_ON',
  'MENTIONS',
  'OWNS',
  'REPLY_TO',
  'RELATED_TO',
  'REVIEWED',
  'SAME_AS',
  'SENT',
] as const;
/** Viewer preset identifiers owned by Pufu Lens rather than a graph query language. */
export const GRAPH_PRESET_IDS = ['actor-documents', 'recent-relations'] as const;

/** Relation type supported by related-document traversal. */
export type GraphRelatedRelationType = (typeof GRAPH_RELATED_RELATION_TYPES)[number];
/** Canonical graph relation type. */
export type GraphRelationType = (typeof GRAPH_RELATION_TYPES)[number];
/** Server-owned Graph Viewer preset identifier. */
export type GraphPresetId = (typeof GRAPH_PRESET_IDS)[number];

/** Provider-neutral related-document identity and graph provenance. */
export interface GraphRelatedDocumentCandidate {
  readonly documentId: string;
  readonly hopCount: 1 | 2;
  readonly relationType: GraphRelatedRelationType;
  readonly seedDocumentId: string;
}

/** Normalized graph node independent of provider row encodings. */
export interface GraphReadNode {
  readonly id: string;
  readonly label: string;
  readonly labels: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Normalized graph edge independent of provider row encodings. */
export interface GraphReadEdge {
  readonly id: string;
  readonly label: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly target: string;
}

/** Bounded normalized Viewer result with compatibility response fields. */
export interface GraphPresetReadResult {
  readonly edges: readonly GraphReadEdge[];
  readonly nodes: readonly GraphReadNode[];
  readonly preview: string;
  readonly rawRows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
  readonly truncated: boolean;
}

/** Related-document capability outcome with provider errors normalized to unavailable. */
export interface GraphRelatedDocumentReadResult {
  readonly candidates: readonly GraphRelatedDocumentCandidate[];
  readonly status: 'success' | 'unavailable';
}

/**
 * Reads bounded graph capabilities using only a validated project identifier.
 *
 * Provider graph names, query languages, row formats, and transactions remain adapter details.
 */
export interface GraphReadRepository {
  countDocumentNode(input: {
    readonly graphNodeId: string;
    readonly projectId: string;
  }): Promise<number>;
  countRelations(input: {
    readonly graphNodeId: string;
    readonly projectId: string;
    readonly relationTypes: readonly GraphRelationType[];
  }): Promise<Readonly<Partial<Record<GraphRelationType, number>>>>;
  findRelatedDocuments(input: {
    readonly projectId: string;
    readonly relationLimits?: Partial<Record<GraphRelatedRelationType, number>>;
    readonly seedDocumentIds: readonly string[];
  }): Promise<GraphRelatedDocumentReadResult>;
  readPreset(input: {
    readonly documentGraphNodeIds: readonly string[];
    readonly presetId: GraphPresetId;
    readonly projectId: string;
  }): Promise<GraphPresetReadResult>;
}

/** Parses a provider-neutral related-document candidate at an adapter boundary. */
export function parseGraphRelatedDocumentCandidate(value: unknown): GraphRelatedDocumentCandidate {
  const record = requireRecord(value, 'graph related document candidate');
  const hopCount = record.hopCount;
  if (hopCount !== 1 && hopCount !== 2) {
    throw new Error('Invalid graph related document candidate field: hopCount');
  }
  const relationType = record.relationType;
  if (!isGraphRelatedRelationType(relationType)) {
    throw new Error('Invalid graph related document candidate field: relationType');
  }
  return {
    documentId: requireNonEmptyString(record.documentId, 'documentId'),
    hopCount,
    relationType,
    seedDocumentId: requireNonEmptyString(record.seedDocumentId, 'seedDocumentId'),
  };
}

/** Parses a normalized graph node returned by a provider adapter. */
export function parseGraphReadNode(value: unknown): GraphReadNode {
  const record = requireRecord(value, 'graph read node');
  if (!Array.isArray(record.labels) || !record.labels.every(isNonEmptyString)) {
    throw new Error('Invalid graph read node field: labels');
  }
  return {
    id: requireNonEmptyString(record.id, 'id'),
    label: requireNonEmptyString(record.label, 'label'),
    labels: [...record.labels],
    properties: requireSafeJsonRecord(record.properties, 'graph read node properties'),
  };
}

/** Parses a normalized graph edge returned by a provider adapter. */
export function parseGraphReadEdge(value: unknown): GraphReadEdge {
  const record = requireRecord(value, 'graph read edge');
  return {
    id: requireNonEmptyString(record.id, 'id'),
    label: requireNonEmptyString(record.label, 'label'),
    properties: requireSafeJsonRecord(record.properties, 'graph read edge properties'),
    source: requireNonEmptyString(record.source, 'source'),
    target: requireNonEmptyString(record.target, 'target'),
  };
}

/** Parses a normalized Viewer preset result and its bounded compatibility payload. */
export function parseGraphPresetReadResult(value: unknown): GraphPresetReadResult {
  const record = requireRecord(value, 'graph preset read result');
  if (!Array.isArray(record.nodes)) {
    throw new Error('Invalid graph preset read result field: nodes');
  }
  if (!Array.isArray(record.edges)) {
    throw new Error('Invalid graph preset read result field: edges');
  }
  if (!Array.isArray(record.rawRows)) {
    throw new Error('Invalid graph preset read result field: rawRows');
  }
  if (typeof record.truncated !== 'boolean') {
    throw new Error('Invalid graph preset read result field: truncated');
  }
  return {
    edges: record.edges.map(parseGraphReadEdge),
    nodes: record.nodes.map(parseGraphReadNode),
    preview: requireNonEmptyString(record.preview, 'preview'),
    rawRows: record.rawRows.map((row) => requireSafeJsonRecord(row, 'rawRows')),
    rowCount: parseGraphCountResult(record.rowCount),
    truncated: record.truncated,
  };
}

/** Parses a graph node or relation count without accepting provider string encodings. */
export function parseGraphCountResult(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid graph count result.');
  }
  return value;
}

/** Parses a provider-neutral Viewer preset identifier. */
export function parseGraphPresetId(value: unknown): GraphPresetId {
  if (typeof value !== 'string' || !(GRAPH_PRESET_IDS as readonly string[]).includes(value)) {
    throw new Error('Invalid graph preset id.');
  }
  return value as GraphPresetId;
}

/** Parses the bounded graph relation allowlist used by count capabilities. */
export function parseGraphRelationTypes(value: unknown): readonly GraphRelationType[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        typeof entry === 'string' && (GRAPH_RELATION_TYPES as readonly string[]).includes(entry),
    )
  ) {
    throw new Error('Invalid graph relation types.');
  }
  return [...new Set(value)] as GraphRelationType[];
}

/** Bootstrap project identity resolved before project-scoped graph operations. */
export interface ProjectResolverResult {
  readonly projectId: string;
  readonly projectSlug: string;
}

/** Resolves validated project identifiers from a slug without exposing provider details. */
export interface ProjectResolver {
  resolveBySlug(slug: string): Promise<ProjectResolverResult | undefined>;
}

/** Document types supported by graph indexing lookups. */
export const GRAPH_INDEXING_DOCUMENT_TYPES = [
  'drive_doc',
  'email',
  'issue',
  'pull_request',
  'web_page',
] as const;

/** Finite document type union used by graph indexing document records. */
export type GraphIndexingDocumentType = (typeof GRAPH_INDEXING_DOCUMENT_TYPES)[number];

/** Actor alias kinds supported by graph indexing lookups. */
export type GraphIndexingActorAliasType = 'email' | 'github_login' | 'domain';

/** Actor row returned by graph indexing lookups. */
export interface GraphIndexingActorRecord {
  readonly displayName: string;
  readonly graphNodeId: string;
  readonly id: string;
}

/** Document row returned by graph indexing lookups. */
export interface GraphIndexingDocumentRecord {
  readonly docType: GraphIndexingDocumentType;
  readonly graphNodeId: string;
  readonly id: string;
  readonly rawDocumentId: string;
  readonly sourceId: string;
}

/** Graph indexing target with provider-neutral document metadata and unparsed payload. */
export interface GraphIndexingTarget {
  readonly document: GraphIndexingDocumentRecord;
  readonly parsed: unknown;
  readonly rawContentHash: string;
  readonly rawDocumentId: string;
}

/** Email quote row stored by graph indexing workflows. */
export interface GraphIndexingEmailQuoteInput {
  readonly bodyText: string;
  readonly prevQuoteIndex?: number;
  readonly quoteIndex: number;
  readonly quotedMessageId: string;
  readonly senderActorId?: string;
  readonly senderAlias: string;
  readonly sentAt: string;
}

/** Provider-neutral email quote replacement input scoped by project. */
export interface ReplaceGraphIndexingEmailQuotesInput {
  readonly documentId: string;
  readonly projectId: string;
  readonly quotes: readonly GraphIndexingEmailQuoteInput[];
}

/**
 * Relational graph indexing responsibilities formerly mixed into legacy graph repositories.
 *
 * Node/edge mutation, graph traversal, and slug bootstrap lookup stay outside this boundary.
 */
export interface GraphIndexingRepository {
  findActorByAlias(input: {
    readonly aliasType: GraphIndexingActorAliasType;
    readonly aliasValue: string;
    readonly projectId: string;
  }): Promise<GraphIndexingActorRecord | undefined>;
  findActorByGraphNodeId(input: {
    readonly graphNodeId: string;
    readonly projectId: string;
  }): Promise<GraphIndexingActorRecord | undefined>;
  findDocumentsBySourceIds(input: {
    readonly projectId: string;
    readonly sourceIds: readonly string[];
  }): Promise<readonly GraphIndexingDocumentRecord[]>;
  findSameAsDocuments(input: {
    readonly projectId: string;
    readonly rawContentHash: string;
    readonly rawDocumentId: string;
    readonly sourceType: string;
  }): Promise<readonly GraphIndexingDocumentRecord[]>;
  markFailed(input: {
    readonly errorMessage: string;
    readonly projectId: string;
    readonly rawDocumentId: string;
  }): Promise<void>;
  markIndexed(input: { readonly projectId: string; readonly rawDocumentId: string }): Promise<void>;
  readGraphTargets(input: {
    readonly limit: number;
    readonly projectId: string;
  }): Promise<readonly GraphIndexingTarget[]>;
  replaceEmailQuotes(input: ReplaceGraphIndexingEmailQuotesInput): Promise<void>;
}

/** Provider-neutral node upsert input scoped by validated project identifier. */
export interface GraphMutationNodeInput {
  readonly graphNodeId: string;
  readonly labels: readonly string[];
  readonly projectId: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Provider-neutral edge upsert input with allowlisted relation types. */
export interface GraphMutationEdgeInput {
  readonly fromGraphNodeId: string;
  readonly projectId: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly relationType: GraphRelationType;
  readonly toGraphNodeId: string;
}

/** Provider-neutral actor merge input scoped by validated project identifier. */
export interface GraphActorMergeInput {
  readonly primaryActorId: string;
  readonly primaryGraphNodeId: string;
  readonly projectId: string;
  readonly secondaryGraphNodeId: string;
}

/** Actor merge outcome with parsed counts or safe skip/unavailable reasons. */
export type GraphActorMergeResult =
  | { readonly deletedCount: number; readonly status: 'merged' }
  | { readonly reason: string; readonly status: 'skipped' }
  | { readonly status: 'unavailable' };

/** Bounded document graph cleanup input scoped by validated project identifier. */
export interface GraphDocumentCleanupInput {
  readonly graphNodeIds: readonly string[];
  readonly projectId: string;
}

/** Project-scoped graph lifecycle mutation input validated at adapter boundaries. */
export interface GraphProjectMutationInput {
  readonly projectId: string;
}

/**
 * Project-scoped graph mutation capability without provider graph names or query languages.
 */
export interface GraphMutationRepository {
  deleteDocumentGraphNodes(input: GraphDocumentCleanupInput): Promise<number>;
  deleteProjectGraph(input: GraphProjectMutationInput): Promise<void>;
  ensureProjectGraph(input: GraphProjectMutationInput): Promise<void>;
  mergeActorGraphNodes(input: GraphActorMergeInput): Promise<GraphActorMergeResult>;
  upsertEdge(input: GraphMutationEdgeInput): Promise<void>;
  upsertNode(input: GraphMutationNodeInput): Promise<void>;
}

/** Parses a graph indexing document type at an adapter boundary. */
export function parseGraphIndexingDocumentType(value: unknown): GraphIndexingDocumentType {
  if (
    typeof value !== 'string' ||
    !(GRAPH_INDEXING_DOCUMENT_TYPES as readonly string[]).includes(value)
  ) {
    throw new Error('Invalid graph indexing document type.');
  }
  return value as GraphIndexingDocumentType;
}

/** Parses bootstrap project resolver output without provider-specific fields. */
export function parseGraphProjectResolverResult(value: unknown): ProjectResolverResult {
  const record = requireExactRecord(value, 'graph project resolver result', [
    'projectId',
    'projectSlug',
  ]);
  return {
    projectId: requireNonEmptyString(record.projectId, 'projectId'),
    projectSlug: requireNonEmptyString(record.projectSlug, 'projectSlug'),
  };
}

/** Parses a project-scoped graph node mutation input at an adapter boundary. */
export function parseGraphMutationNodeInput(value: unknown): GraphMutationNodeInput {
  const record = requireExactRecord(value, 'graph mutation node input', [
    'graphNodeId',
    'labels',
    'projectId',
    'properties',
  ]);
  if (!Array.isArray(record.labels) || record.labels.length === 0) {
    throw new Error('Invalid graph mutation node input field: labels');
  }
  if (!record.labels.every(isNonEmptyString)) {
    throw new Error('Invalid graph mutation node input field: labels');
  }
  return {
    graphNodeId: requireNonEmptyString(record.graphNodeId, 'graphNodeId'),
    labels: [...record.labels],
    projectId: requireNonEmptyString(record.projectId, 'projectId'),
    properties: requireSafeJsonRecord(record.properties, 'graph mutation node properties'),
  };
}

/** Parses a project-scoped graph edge mutation input at an adapter boundary. */
export function parseGraphMutationEdgeInput(value: unknown): GraphMutationEdgeInput {
  const record = requireExactRecord(value, 'graph mutation edge input', [
    'fromGraphNodeId',
    'projectId',
    'properties',
    'relationType',
    'toGraphNodeId',
  ]);
  const relationType = record.relationType;
  if (!isGraphRelationType(relationType)) {
    throw new Error('Invalid graph mutation edge input field: relationType');
  }
  return {
    fromGraphNodeId: requireNonEmptyString(record.fromGraphNodeId, 'fromGraphNodeId'),
    projectId: requireNonEmptyString(record.projectId, 'projectId'),
    properties: requireSafeJsonRecord(record.properties, 'graph mutation edge properties'),
    relationType,
    toGraphNodeId: requireNonEmptyString(record.toGraphNodeId, 'toGraphNodeId'),
  };
}

/** Parses a project-scoped actor merge input at an adapter boundary. */
export function parseGraphActorMergeInput(value: unknown): GraphActorMergeInput {
  const record = requireExactRecord(value, 'graph actor merge input', [
    'primaryActorId',
    'primaryGraphNodeId',
    'projectId',
    'secondaryGraphNodeId',
  ]);
  return {
    primaryActorId: requireNonEmptyString(record.primaryActorId, 'primaryActorId'),
    primaryGraphNodeId: requireNonEmptyString(record.primaryGraphNodeId, 'primaryGraphNodeId'),
    projectId: requireNonEmptyString(record.projectId, 'projectId'),
    secondaryGraphNodeId: requireNonEmptyString(
      record.secondaryGraphNodeId,
      'secondaryGraphNodeId',
    ),
  };
}

/** Parses an actor merge mutation result without provider row encodings. */
export function parseGraphActorMergeResult(value: unknown): GraphActorMergeResult {
  const record = requireRecord(value, 'graph actor merge result');
  const status = record.status;
  if (status === 'merged') {
    const exact = requireExactRecord(value, 'graph actor merge result', ['deletedCount', 'status']);
    return {
      deletedCount: parseGraphCountResult(exact.deletedCount),
      status: 'merged',
    };
  }
  if (status === 'skipped') {
    const exact = requireExactRecord(value, 'graph actor merge result', ['reason', 'status']);
    return {
      reason: requireNonEmptyString(exact.reason, 'reason'),
      status: 'skipped',
    };
  }
  if (status === 'unavailable') {
    requireExactRecord(value, 'graph actor merge result', ['status']);
    return { status: 'unavailable' };
  }
  throw new Error('Invalid graph actor merge result field: status');
}

/** Parses project-scoped graph lifecycle mutation input at an adapter boundary. */
export function parseGraphProjectMutationInput(value: unknown): GraphProjectMutationInput {
  const record = requireExactRecord(value, 'graph project mutation input', ['projectId']);
  return {
    projectId: requireNonEmptyString(record.projectId, 'projectId'),
  };
}

/** Parses bounded document graph cleanup input scoped by project identifier. */
export function parseGraphDocumentCleanupInput(value: unknown): GraphDocumentCleanupInput {
  const record = requireExactRecord(value, 'graph document cleanup input', [
    'graphNodeIds',
    'projectId',
  ]);
  if (!Array.isArray(record.graphNodeIds)) {
    throw new Error('Invalid graph document cleanup input field: graphNodeIds');
  }
  if (record.graphNodeIds.length === 0) {
    throw new Error('Invalid graph document cleanup input field: graphNodeIds');
  }
  if (!record.graphNodeIds.every(isNonEmptyString)) {
    throw new Error('Invalid graph document cleanup input field: graphNodeIds');
  }
  return {
    graphNodeIds: [...record.graphNodeIds],
    projectId: requireNonEmptyString(record.projectId, 'projectId'),
  };
}

/** Parses a document cleanup mutation result and returns the deleted node count. */
export function parseGraphDocumentCleanupResult(value: unknown): number {
  const record = requireExactRecord(value, 'graph document cleanup result', ['deletedCount']);
  return parseGraphCountResult(record.deletedCount);
}

function isGraphRelationType(value: unknown): value is GraphRelationType {
  return typeof value === 'string' && (GRAPH_RELATION_TYPES as readonly string[]).includes(value);
}

function isGraphRelatedRelationType(value: unknown): value is GraphRelatedRelationType {
  return (
    typeof value === 'string' && (GRAPH_RELATED_RELATION_TYPES as readonly string[]).includes(value)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`Invalid graph field: ${fieldName}`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Invalid ${label} field: ${key}`);
    }
  }
  return record;
}

function requireSafeJsonRecord(value: unknown, label: string): Record<string, unknown> {
  const record = requireRecord(value, label);
  const seen = new WeakSet<object>();
  seen.add(record);
  for (const nested of Object.values(record)) {
    if (!isSafeJsonValue(nested, seen)) {
      throw new Error(`Invalid ${label}.`);
    }
  }
  seen.delete(record);
  return record;
}

/** Validates a JSON-serializable graph property value without leaking unsafe encodings. */
export function requireSafeJsonValue(value: unknown, label: string): unknown {
  if (!isSafeJsonValue(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function isSafeJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    const safe = value.every((entry) => isSafeJsonValue(entry, seen));
    seen.delete(value);
    return safe;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    const safe = Object.values(value as Record<string, unknown>).every((entry) =>
      isSafeJsonValue(entry, seen),
    );
    seen.delete(value);
    return safe;
  }
  return false;
}
