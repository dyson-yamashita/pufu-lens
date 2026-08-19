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

function requireSafeJsonRecord(value: unknown, label: string): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const nested of Object.values(record)) {
    if (!isSafeJsonValue(nested)) {
      throw new Error(`Invalid ${label}.`);
    }
  }
  return record;
}

function isSafeJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isSafeJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isSafeJsonValue);
  }
  return false;
}
