import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { getRequiredAdminSql } from './admin-sql.ts';
import { lookupProjectMemberAccess } from './authz.ts';
import { graphPropertyString as propertyString } from './graph-property-utils.ts';

export type GraphPresetId = 'actor-documents' | 'recent-relations';

export type GraphPresetSummary = {
  readonly defaultLimit: number;
  readonly description: string;
  readonly id: GraphPresetId;
  readonly label: string;
  readonly maxLimit: number;
  readonly preview: string;
};

export type GraphViewerNode = {
  readonly id: string;
  readonly label: string;
  readonly labels: readonly string[];
  readonly properties: Record<string, unknown>;
};

export type GraphViewerDocumentChunk = {
  readonly chunkIndex: number;
  readonly content: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly id: string;
  readonly metadata: Record<string, unknown>;
};

export type GraphViewerEdge = {
  readonly id: string;
  readonly label: string;
  readonly properties: Record<string, unknown>;
  readonly source: string;
  readonly target: string;
};

export type GraphPeriodFilter = {
  readonly periodEnd?: string;
  readonly periodStart?: string;
};

export type GraphQueryResult = {
  readonly documentCount: number;
  readonly edges: readonly GraphViewerEdge[];
  readonly graphName: string;
  readonly limit: number;
  readonly nodes: readonly GraphViewerNode[];
  readonly periodEnd?: string;
  readonly periodStart?: string;
  readonly preset: GraphPresetSummary;
  readonly rawRows: readonly Record<string, unknown>[];
  readonly rowCount: number;
  readonly truncated: boolean;
};

export type GraphProjectAccess = {
  readonly graphName: string;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
};

type GraphPreset = Omit<GraphPresetSummary, 'preview'> & {
  readonly cypherBody: string;
  readonly maxEdges: number;
  readonly maxNodes: number;
  readonly recordDefinition: string;
};

export interface GraphViewerRepository {
  executePreset(input: {
    cypher: string;
    graphName: string;
    parameters: Record<string, unknown>;
    preset: GraphPreset;
  }): Promise<readonly Record<string, unknown>[]>;
  selectEligibleDocumentGraphNodeIds(input: {
    limit: number;
    periodEnd?: string;
    periodStart?: string;
    projectId: string;
  }): Promise<readonly string[]>;
  fetchDocumentChunks(input: {
    documentIds: readonly string[];
    projectId: string;
  }): Promise<ReadonlyMap<string, readonly GraphViewerDocumentChunk[]>>;
  lookupPublicProject(input: { projectSlug: string }): Promise<GraphProjectAccess | undefined>;
  lookupProjectMember(input: {
    projectSlug: string;
    userId: string;
  }): Promise<GraphProjectAccess | undefined>;
}

export const GRAPH_DEFAULT_LIMIT = 100;
export const GRAPH_MAX_LIMIT = 500;
export const GRAPH_MIN_LIMIT = 1;

export class GraphAccessDeniedError extends Error {
  constructor(projectSlug: string) {
    super(`Graph access denied for project slug: ${projectSlug}`);
    this.name = 'GraphAccessDeniedError';
  }
}

export class GraphPresetNotFoundError extends Error {
  constructor(queryId: string) {
    super(`Unknown graph query preset: ${queryId}`);
    this.name = 'GraphPresetNotFoundError';
  }
}

export class GraphLimitError extends Error {
  constructor(limit: unknown, min: number = GRAPH_MIN_LIMIT, max: number = GRAPH_MAX_LIMIT) {
    super(`Graph limit must be an integer between ${min} and ${max}: ${String(limit)}`);
    this.name = 'GraphLimitError';
  }
}

export class GraphInvalidDocumentIdError extends Error {
  constructor(documentId: unknown) {
    super(`Invalid graph documentId: ${String(documentId)}`);
    this.name = 'GraphInvalidDocumentIdError';
  }
}

export class GraphPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphPeriodError';
  }
}

const GRAPH_PRESET_DOCUMENT_IDS_PARAM = 'documentGraphNodeIds';

export const GRAPH_PRESETS: readonly GraphPreset[] = [
  {
    cypherBody: [
      'MATCH (doc:Document)',
      'WHERE doc.graphNodeId IN $documentGraphNodeIds',
      'MATCH (doc)-[relation]-(neighbor)',
      'WHERE neighbor:Actor OR neighbor:Topic',
      'OR (neighbor:Document AND neighbor.graphNodeId IN $documentGraphNodeIds)',
      'RETURN doc AS source, relation, neighbor AS target',
    ].join(' '),
    defaultLimit: GRAPH_DEFAULT_LIMIT,
    description: 'Document、Actor、Topic など、直近の関係を横断して確認します。',
    id: 'recent-relations',
    label: 'Recent Relations',
    maxEdges: GRAPH_MAX_LIMIT,
    maxLimit: GRAPH_MAX_LIMIT,
    maxNodes: 600,
    recordDefinition: 'source agtype, relation agtype, target agtype',
  },
  {
    cypherBody: [
      'MATCH (source:Actor)-[relation]->(target:Document)',
      'WHERE target.graphNodeId IN $documentGraphNodeIds',
      'RETURN source, relation, target',
    ].join(' '),
    defaultLimit: GRAPH_DEFAULT_LIMIT,
    description: 'Actor から Document への関係を確認します。',
    id: 'actor-documents',
    label: 'Actors to Documents',
    maxEdges: GRAPH_MAX_LIMIT,
    maxLimit: GRAPH_MAX_LIMIT,
    maxNodes: 600,
    recordDefinition: 'source agtype, relation agtype, target agtype',
  },
];

/**
 * Builds the server-owned preset Cypher query with a fixed raw result-row safety limit.
 *
 * @param preset - The graph preset whose maxEdges bound is applied
 * @returns The preset Cypher body with a numeric LIMIT that cannot be controlled by request input
 */
export function buildPresetCypher(preset: GraphPreset): string {
  const maxResultRows = validatePresetResultRowLimit(preset.maxEdges);
  return `${preset.cypherBody} LIMIT ${maxResultRows}`;
}

/**
 * Lists the available graph presets.
 *
 * @returns The available preset summaries with preview queries generated from each preset's default limit.
 */
export function listGraphPresets(): readonly GraphPresetSummary[] {
  return GRAPH_PRESETS.map(
    ({ cypherBody, defaultLimit, description, id, label, maxLimit, maxEdges }) => ({
      defaultLimit,
      description,
      id,
      label,
      maxLimit,
      preview: `${cypherBody} LIMIT ${maxEdges}`,
    }),
  );
}

/**
 * Finds a graph preset by ID.
 *
 * @param queryId - The preset ID to look up
 * @returns The matching graph preset
 * @throws {GraphPresetNotFoundError} Thrown when no preset matches `queryId`
 */
export function getGraphPreset(queryId: string): GraphPreset {
  const preset = GRAPH_PRESETS.find((candidate) => candidate.id === queryId);
  if (!preset) {
    throw new GraphPresetNotFoundError(queryId);
  }
  return preset;
}

/**
 * Runs a graph preset query for an accessible project.
 *
 * @param input - Query parameters including the project, preset ID, and optional limit.
 * @param options - Repository used to resolve project access and execute the preset.
 * @returns The normalized graph result, including preset metadata, raw rows, and the applied limit.
 */
export async function runGraphPresetQuery(
  input: {
    limit?: number;
    periodEnd?: unknown;
    periodStart?: unknown;
    projectSlug: string;
    queryId: string;
    userId: string;
  },
  options: { repository: GraphViewerRepository },
): Promise<GraphQueryResult> {
  const project = await options.repository.lookupProjectMember({
    projectSlug: input.projectSlug,
    userId: input.userId,
  });
  if (!project) {
    throw new GraphAccessDeniedError(input.projectSlug);
  }

  const period = normalizeGraphPeriodFilter({
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
  });

  return executeGraphPresetForProject(
    { limit: input.limit, period, queryId: input.queryId },
    { graphName: project.graphName, projectId: project.id, repository: options.repository },
  );
}

/**
 * Runs a graph preset query for a public project without requiring member authentication.
 *
 * @param input - Query parameters including the project, preset ID, and optional limit.
 * @param options - Repository used to resolve public project access and execute the preset.
 * @returns The normalized graph result, including preset metadata, raw rows, and the applied limit.
 */
export async function runPublicGraphPresetQuery(
  input: {
    limit?: unknown;
    periodEnd?: unknown;
    periodStart?: unknown;
    projectSlug: string;
    queryId: string;
  },
  options: { repository: GraphViewerRepository },
): Promise<GraphQueryResult> {
  const project = await options.repository.lookupPublicProject({
    projectSlug: input.projectSlug,
  });
  if (!project) {
    throw new GraphAccessDeniedError(input.projectSlug);
  }

  const period = normalizeGraphPeriodFilter({
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
  });

  return executeGraphPresetForProject(
    { limit: input.limit, period, queryId: input.queryId },
    { graphName: project.graphName, projectId: project.id, repository: options.repository },
  );
}

async function executeGraphPresetForProject(
  input: { limit?: unknown; period: GraphPeriodFilter; queryId: string },
  options: {
    graphName: string;
    projectId: string;
    repository: Pick<GraphViewerRepository, 'executePreset' | 'selectEligibleDocumentGraphNodeIds'>;
  },
): Promise<GraphQueryResult> {
  const preset = getGraphPreset(input.queryId);
  const limit = normalizeGraphLimit(input.limit ?? preset.defaultLimit, preset.maxLimit);
  const documentGraphNodeIds = await options.repository.selectEligibleDocumentGraphNodeIds({
    limit,
    periodEnd: input.period.periodEnd,
    periodStart: input.period.periodStart,
    projectId: options.projectId,
  });
  const parameters = { [GRAPH_PRESET_DOCUMENT_IDS_PARAM]: documentGraphNodeIds };
  const cypher = buildPresetCypher(preset);
  const rows = await options.repository.executePreset({
    cypher,
    graphName: options.graphName,
    parameters,
    preset,
  });
  const normalized = normalizeGraphRows(rows, {
    maxEdges: preset.maxEdges,
    maxNodes: preset.maxNodes,
  });
  const documentCount = countGraphDocumentNodes(normalized.nodes);

  return {
    ...normalized,
    documentCount,
    graphName: options.graphName,
    limit,
    ...(input.period.periodStart ? { periodStart: input.period.periodStart } : {}),
    ...(input.period.periodEnd ? { periodEnd: input.period.periodEnd } : {}),
    preset: {
      defaultLimit: preset.defaultLimit,
      description: preset.description,
      id: preset.id,
      label: preset.label,
      maxLimit: preset.maxLimit,
      preview: cypher,
    },
    rawRows: rows.map(safeRawRow),
    rowCount: rows.length,
  };
}

/**
 * Counts Document nodes in a normalized graph result.
 *
 * @param nodes - The normalized graph nodes returned to the client
 * @returns The number of nodes labeled Document
 */
export function countGraphDocumentNodes(nodes: readonly GraphViewerNode[]): number {
  return nodes.filter((node) => node.labels.includes('Document')).length;
}

/**
 * Parses eligible document graph_node_id rows from a PostgreSQL query result.
 *
 * @param rows - Raw SQL rows returned by the eligible-document selection query
 * @returns Parsed graph_node_id values in query order
 */
export function parseEligibleDocumentGraphNodeIdRows(rows: readonly unknown[]): readonly string[] {
  return rows.map(parseEligibleDocumentGraphNodeIdRow);
}

/**
 * Returns the documentId property from a graph node when present.
 *
 * @param node - The graph node to inspect
 * @returns The documentId value, or undefined when the node is not a document
 */
export function graphNodeDocumentId(node: GraphViewerNode): string | undefined {
  return propertyString(node.properties, 'documentId');
}

/**
 * Loads document chunks for a graph document node after project access is verified.
 *
 * @param input - The project, document ID, and requesting user
 * @param options - Repository used to resolve project access and fetch document chunks
 * @returns The document chunks for the requested document
 * @throws GraphAccessDeniedError If the user cannot access the project
 * @throws GraphInvalidDocumentIdError If documentId is missing or blank
 */
export async function fetchGraphDocumentChunks(
  input: { documentId: string; projectSlug: string; userId: string },
  options: {
    repository: Pick<GraphViewerRepository, 'fetchDocumentChunks' | 'lookupProjectMember'>;
  },
): Promise<readonly GraphViewerDocumentChunk[]> {
  const documentId = input.documentId.trim();
  if (!documentId) {
    throw new GraphInvalidDocumentIdError(input.documentId);
  }
  const project = await options.repository.lookupProjectMember({
    projectSlug: input.projectSlug,
    userId: input.userId,
  });
  if (!project) {
    throw new GraphAccessDeniedError(input.projectSlug);
  }
  const chunksByDocumentId = await options.repository.fetchDocumentChunks({
    documentIds: [documentId],
    projectId: project.id,
  });
  return chunksByDocumentId.get(documentId) ?? [];
}

/**
 * Validates a graph query limit.
 *
 * @param limit - The requested limit value
 * @param maxLimit - The upper bound to allow for the limit
 * @returns The validated limit value
 */
export function normalizeGraphLimit(limit: unknown, maxLimit: number = GRAPH_MAX_LIMIT): number {
  const normalizedMax = Math.min(Math.max(maxLimit, GRAPH_MIN_LIMIT), GRAPH_MAX_LIMIT);
  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    throw new GraphLimitError(limit, GRAPH_MIN_LIMIT, normalizedMax);
  }
  if (limit < GRAPH_MIN_LIMIT || limit > normalizedMax) {
    throw new GraphLimitError(limit, GRAPH_MIN_LIMIT, normalizedMax);
  }
  return limit;
}

/**
 * Validates optional graph period bounds from a request body.
 *
 * @param input - Optional period start and end values
 * @returns Normalized period bounds with blank sides omitted
 * @throws {GraphPeriodError} When a bound is invalid or start is after end
 */
export function normalizeGraphPeriodFilter(input: {
  periodEnd?: unknown;
  periodStart?: unknown;
}): GraphPeriodFilter {
  const periodStart = normalizeOptionalIsoDate(input.periodStart, 'periodStart');
  const periodEnd = normalizeOptionalIsoDate(input.periodEnd, 'periodEnd');
  if (periodStart && periodEnd && periodStart > periodEnd) {
    throw new GraphPeriodError('periodStart must be before or equal to periodEnd.');
  }
  return {
    ...(periodEnd ? { periodEnd } : {}),
    ...(periodStart ? { periodStart } : {}),
  };
}

function normalizeOptionalIsoDate(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new GraphPeriodError(`${fieldName} must be YYYY-MM-DD.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new GraphPeriodError(`${fieldName} must be YYYY-MM-DD.`);
  }
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new GraphPeriodError(`${fieldName} must be a valid date.`);
  }
  return trimmed;
}

/**
 * Creates a PostgreSQL-backed graph viewer repository.
 *
 * @returns A repository that executes preset graph queries, loads document chunks, and looks up project graph access.
 */
export function createPostgresGraphViewerRepository(
  sql: postgres.Sql = getRequiredAdminSql(),
): GraphViewerRepository {
  return {
    async executePreset({ cypher, graphName, parameters, preset }) {
      const safeGraphName = validateGraphName(graphName);
      const safeRecordDefinition = validateRecordDefinition(preset.recordDefinition);
      return sql.begin(async (transaction) => {
        await transaction`SET TRANSACTION READ ONLY`;
        await transaction`LOAD 'age'`;
        await transaction`SET LOCAL search_path = ag_catalog, "$user", public`;
        await transaction`SET LOCAL statement_timeout = '5000ms'`;
        return transaction.unsafe(
          `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
            cypher,
          )}, $1::agtype) AS (${safeRecordDefinition})`,
          [JSON.stringify(parameters)],
        ) as Promise<readonly Record<string, unknown>[]>;
      });
    },
    async selectEligibleDocumentGraphNodeIds({ limit, periodEnd, periodStart, projectId }) {
      return sql.begin(async (transaction) => {
        await transaction`SET TRANSACTION READ ONLY`;
        await transaction`SET LOCAL statement_timeout = '5000ms'`;
        const rows: readonly unknown[] = await transaction`
          SELECT graph_node_id
          FROM public.documents
          WHERE project_id = ${projectId}
            AND (${periodStart ?? null}::date IS NULL OR occurred_at >= ${periodStart ?? null}::date)
            AND (
              ${periodEnd ?? null}::date IS NULL
              OR occurred_at < (${periodEnd ?? null}::date + INTERVAL '1 day')
            )
          ORDER BY occurred_at DESC NULLS LAST, updated_at DESC, id ASC
          LIMIT ${limit}
        `;
        return parseEligibleDocumentGraphNodeIdRows(rows);
      });
    },
    async fetchDocumentChunks({ documentIds, projectId }) {
      if (documentIds.length === 0) {
        return new Map();
      }
      return sql.begin(async (transaction) => {
        await transaction`SET TRANSACTION READ ONLY`;
        await transaction`SET LOCAL statement_timeout = '5000ms'`;
        const rows = (await transaction`
          SELECT
            dc.document_id::text AS document_id,
            dc.id::text AS id,
            dc.chunk_index,
            dc.content,
            dc.content_hash,
            dc.metadata,
            dc.created_at::text AS created_at
          FROM public.document_chunks dc
          WHERE dc.project_id = ${projectId}
            AND dc.document_id IN ${transaction(documentIds)}
          ORDER BY dc.document_id, dc.chunk_index
        `) as readonly Record<string, unknown>[];
        const chunksByDocumentId = new Map<string, GraphViewerDocumentChunk[]>();
        for (const row of rows) {
          const { chunk, documentId } = parseGraphDocumentChunkRow(row);
          const chunks = chunksByDocumentId.get(documentId) ?? [];
          chunks.push(chunk);
          chunksByDocumentId.set(documentId, chunks);
        }
        return chunksByDocumentId;
      });
    },
    async lookupProjectMember({ projectSlug, userId }) {
      const access = await lookupProjectMemberAccess(sql, { projectSlug, userId });
      if (!access?.graphName) {
        return undefined;
      }
      return {
        graphName: validateGraphName(access.graphName),
        id: access.id,
        name: access.name,
        slug: access.slug,
      };
    },
    async lookupPublicProject({ projectSlug }) {
      const rows: readonly unknown[] = await sql`
        SELECT id::text, slug, name, graph_name AS "graphName"
        FROM public.projects
        WHERE slug = ${projectSlug}
          AND visibility = 'public'
        LIMIT 1
      `;
      const row = rows[0];
      if (!isRecord(row)) {
        return undefined;
      }
      const graphNameValue = row.graphName;
      if (typeof graphNameValue !== 'string') {
        return undefined;
      }
      const graphName = graphNameValue.trim();
      if (!graphName) {
        return undefined;
      }
      return {
        graphName: validateGraphName(graphName),
        id: requireString(row.id, 'project id'),
        name: requireString(row.name, 'project name'),
        slug: requireString(row.slug, 'project slug'),
      };
    },
  };
}

export function normalizeGraphRows(
  rows: readonly Record<string, unknown>[],
  limits: { maxEdges: number; maxNodes: number },
): Pick<GraphQueryResult, 'edges' | 'nodes' | 'truncated'> {
  const nodes = new Map<string, GraphViewerNode>();
  const edges = new Map<string, GraphViewerEdge>();
  let truncated = false;

  for (const row of rows) {
    for (const value of Object.values(row)) {
      collectGraphValue(value, { edges, limits, nodes, truncated: () => (truncated = true) });
    }
  }

  return {
    edges: [...edges.values()],
    nodes: [...nodes.values()],
    truncated,
  };
}

function collectGraphValue(
  value: unknown,
  state: {
    edges: Map<string, GraphViewerEdge>;
    limits: { maxEdges: number; maxNodes: number };
    nodes: Map<string, GraphViewerNode>;
    truncated: () => void;
  },
): void {
  const parsed = parseGraphValue(value);
  if (!parsed) {
    return;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      collectGraphValue(item, state);
    }
    return;
  }
  if (isParsedNode(parsed)) {
    if (state.nodes.size >= state.limits.maxNodes && !state.nodes.has(parsed.id)) {
      state.truncated();
      return;
    }
    state.nodes.set(parsed.id, parsed);
    return;
  }
  if (isParsedEdge(parsed)) {
    if (state.edges.size >= state.limits.maxEdges && !state.edges.has(parsed.id)) {
      state.truncated();
      return;
    }
    state.edges.set(parsed.id, parsed);
  }
}

function parseGraphValue(
  value: unknown,
): GraphViewerNode | GraphViewerEdge | unknown[] | undefined {
  if (typeof value === 'string') {
    return parseTypedAgtype(value.trim());
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (isParsedNode(value) || isParsedEdge(value)) {
    return value;
  }
  if (isAgeVertexRecord(value)) {
    return vertexRecordToNode(value);
  }
  if (isAgeEdgeRecord(value)) {
    return edgeRecordToEdge(value);
  }
  if (Array.isArray(value.vertices) || Array.isArray(value.edges)) {
    return [
      ...((value.vertices as unknown[] | undefined) ?? []),
      ...((value.edges as unknown[] | undefined) ?? []),
    ];
  }
  return undefined;
}

function parseTypedAgtype(
  value: string,
): GraphViewerNode | GraphViewerEdge | unknown[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    if (value.endsWith('::vertex')) {
      return vertexRecordToNode(
        JSON.parse(value.slice(0, -'::vertex'.length)) as Record<string, unknown>,
      );
    }
    if (value.endsWith('::edge')) {
      return edgeRecordToEdge(
        JSON.parse(value.slice(0, -'::edge'.length)) as Record<string, unknown>,
      );
    }
  } catch {
    return undefined;
  }
  if (value.endsWith('::path')) {
    const body = value.slice(0, -'::path'.length);
    return parsePathItems(body);
  }
  return undefined;
}

function parsePathItems(value: string): unknown[] {
  const items: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' && !isEscaped(value, index)) {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (character !== '}') {
      continue;
    }
    depth -= 1;
    if (depth < 0) {
      depth = 0;
      start = -1;
      continue;
    }
    if (depth === 0 && start !== -1) {
      const suffix = value.slice(index + 1).match(/^::(?:vertex|edge)/)?.[0];
      if (suffix) {
        try {
          const parsed = parseTypedAgtype(`${value.slice(start, index + 1)}${suffix}`);
          if (parsed) {
            items.push(parsed);
          }
        } catch {
          // Ignore malformed path fragments and continue parsing later items.
        }
        index += suffix.length;
      }
      start = -1;
    }
  }
  return items;
}

function isEscaped(value: string, index: number): boolean {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function vertexRecordToNode(value: Record<string, unknown>): GraphViewerNode {
  const id = String(value.id ?? value.graphNodeId ?? value.graph_node_id ?? '');
  const label = String(value.label ?? 'Node');
  const properties = isRecord(value.properties) ? value.properties : {};
  const graphNodeId =
    propertyString(properties, 'graphNodeId') ?? propertyString(properties, 'graph_node_id');
  return {
    id,
    label: displayNodeLabel(label, properties),
    labels: [label],
    properties: { ...properties, ageId: id, graphNodeId },
  };
}

function edgeRecordToEdge(value: Record<string, unknown>): GraphViewerEdge {
  const id = String(value.id ?? stableId(value));
  const label = String(value.label ?? 'RELATED');
  const properties = isRecord(value.properties) ? value.properties : {};
  return {
    id,
    label,
    properties,
    source: String(value.start_id ?? value.startId ?? value.source ?? ''),
    target: String(value.end_id ?? value.endId ?? value.target ?? ''),
  };
}

function displayNodeLabel(label: string, properties: Record<string, unknown>): string {
  return (
    propertyString(properties, 'title') ??
    propertyString(properties, 'displayName') ??
    propertyString(properties, 'display_name') ??
    propertyString(properties, 'name') ??
    propertyString(properties, 'canonicalUri') ??
    propertyString(properties, 'canonical_uri') ??
    propertyString(properties, 'target') ??
    propertyString(properties, 'graphNodeId') ??
    label
  );
}

/**
 * Parses a PostgreSQL document chunk row into a typed chunk and document ID.
 *
 * @param row - The raw database row to parse
 * @returns The parsed chunk and its parent document ID
 */
function parseGraphDocumentChunkRow(row: Record<string, unknown>): {
  readonly chunk: GraphViewerDocumentChunk;
  readonly documentId: string;
} {
  const documentId = requireString(row.document_id, 'document chunk document_id');
  return {
    chunk: {
      chunkIndex: requireNumber(row.chunk_index, 'document chunk chunk_index'),
      content: requireString(row.content, 'document chunk content'),
      contentHash: requireString(row.content_hash, 'document chunk content_hash'),
      createdAt: requireString(row.created_at, 'document chunk created_at'),
      id: requireString(row.id, 'document chunk id'),
      metadata: isRecord(row.metadata) ? row.metadata : {},
    },
    documentId,
  };
}

/**
 * Validates that a value is a string.
 *
 * @param value - The value to validate
 * @param label - The name used in the validation error message
 * @returns The validated string
 */
function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

/**
 * Validates and returns a finite numeric value.
 *
 * @param value - The value to validate
 * @param label - The name used in the validation error message
 * @returns The validated number
 */
function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function isAgeVertexRecord(value: Record<string, unknown>): boolean {
  return 'id' in value && 'label' in value && 'properties' in value && !('start_id' in value);
}

function isAgeEdgeRecord(value: Record<string, unknown>): boolean {
  return 'id' in value && 'label' in value && 'start_id' in value && 'end_id' in value;
}

function isParsedNode(value: unknown): value is GraphViewerNode {
  return isRecord(value) && typeof value.id === 'string' && Array.isArray(value.labels);
}

function isParsedEdge(value: unknown): value is GraphViewerEdge {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.source === 'string' &&
    typeof value.target === 'string'
  );
}

function safeRawRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, rawValuePreview(value)]),
  );
}

function rawValuePreview(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 2_000 ? `${value.slice(0, 2_000)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(rawValuePreview);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, nested]) => [key, rawValuePreview(nested)]),
    );
  }
  return value;
}

function stableId(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function dollarQuote(value: string): string {
  const tag = `$pufu_${createHash('sha256').update(value).digest('hex')}$`;
  return `${tag}${value}${tag}`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validateGraphName(graphName: string): string {
  if (!/^graph_[a-z0-9_]+$/.test(graphName) || graphName.length > 63) {
    throw new Error(`Invalid AGE graph name: ${graphName}`);
  }
  return graphName;
}

function validateRecordDefinition(value: string): string {
  if (!/^[a-z_]+ agtype(?:, [a-z_]+ agtype)*$/.test(value)) {
    throw new Error(`Invalid graph preset record definition: ${value}`);
  }
  return value;
}

function validatePresetResultRowLimit(maxEdges: number): number {
  if (!Number.isInteger(maxEdges) || maxEdges < GRAPH_MIN_LIMIT || maxEdges > GRAPH_MAX_LIMIT) {
    throw new Error(`Invalid graph preset result row limit: ${String(maxEdges)}`);
  }
  return maxEdges;
}

function parseEligibleDocumentGraphNodeIdRow(row: unknown): string {
  if (!isRecord(row)) {
    throw new Error('Invalid eligible document row.');
  }
  return requireString(row.graph_node_id, 'document graph_node_id');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
