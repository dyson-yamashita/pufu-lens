import type {
  GraphPresetId,
  GraphPresetReadResult,
  GraphReadEdge,
  GraphReadNode,
  GraphReadRepository,
} from '@pufu-lens/graph';
import { validateGraphName } from '@pufu-lens/project-tenancy';
import type postgres from 'postgres';
import { getRequiredAdminSql } from './admin-sql.ts';
import { lookupProjectMemberAccess } from './authz.ts';
import { graphPropertyString as propertyString } from './graph-property-utils.ts';
import {
  ageGraphPresetPreview,
  createPostgresAgeGraphReadRepository,
} from './postgres-graph-read-adapter.ts';

export type { GraphPresetId } from '@pufu-lens/graph';

export type GraphPresetSummary = {
  readonly defaultLimit: number;
  readonly description: string;
  readonly id: GraphPresetId;
  readonly label: string;
  readonly maxLimit: number;
  readonly preview: string;
};

export type GraphViewerNode = GraphReadNode;

export type GraphViewerDocumentChunk = {
  readonly chunkIndex: number;
  readonly content: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly id: string;
  readonly metadata: Record<string, unknown>;
};

export type GraphViewerEdge = GraphReadEdge;

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
  readonly rawRows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
  readonly truncated: boolean;
};

export type GraphProjectAccess = {
  readonly graphName: string;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
};

type GraphPreset = Omit<GraphPresetSummary, 'preview'>;

export interface GraphViewerRepository {
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

export const GRAPH_DEFAULT_LIMIT = 50;
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

export const GRAPH_PRESETS: readonly GraphPreset[] = [
  {
    defaultLimit: GRAPH_DEFAULT_LIMIT,
    description: 'Document、Actor、Topic など、直近の関係を横断して確認します。',
    id: 'recent-relations',
    label: 'Recent Relations',
    maxLimit: GRAPH_MAX_LIMIT,
  },
  {
    defaultLimit: GRAPH_DEFAULT_LIMIT,
    description: 'Actor から Document への関係を確認します。',
    id: 'actor-documents',
    label: 'Actors to Documents',
    maxLimit: GRAPH_MAX_LIMIT,
  },
];

/**
 * Builds the server-owned preset Cypher query with a fixed raw result-row safety limit.
 *
 * @param preset - The graph preset whose maxEdges bound is applied
 * @returns The preset Cypher body with a numeric LIMIT that cannot be controlled by request input
 */
/**
 * Lists the available graph presets.
 *
 * @returns The available preset summaries with preview queries generated from each preset's default limit.
 */
export function listGraphPresets(): readonly GraphPresetSummary[] {
  return GRAPH_PRESETS.map((preset) => ({
    defaultLimit: preset.defaultLimit,
    description: preset.description,
    id: preset.id,
    label: preset.label,
    maxLimit: preset.maxLimit,
    preview: ageGraphPresetPreview(preset.id),
  }));
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
  options: {
    graphReadRepository: Pick<GraphReadRepository, 'readPreset'>;
    repository: GraphViewerRepository;
  },
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
    {
      graphName: project.graphName,
      graphReadRepository: options.graphReadRepository,
      projectId: project.id,
      repository: options.repository,
    },
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
  options: {
    graphReadRepository: Pick<GraphReadRepository, 'readPreset'>;
    repository: GraphViewerRepository;
  },
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
    {
      graphName: project.graphName,
      graphReadRepository: options.graphReadRepository,
      projectId: project.id,
      repository: options.repository,
    },
  );
}

async function executeGraphPresetForProject(
  input: { limit?: unknown; period: GraphPeriodFilter; queryId: string },
  options: {
    graphName: string;
    graphReadRepository: Pick<GraphReadRepository, 'readPreset'>;
    projectId: string;
    repository: Pick<GraphViewerRepository, 'selectEligibleDocumentGraphNodeIds'>;
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
  const graph = await options.graphReadRepository.readPreset({
    documentGraphNodeIds,
    presetId: preset.id,
    projectId: options.projectId,
  });
  return buildGraphQueryResult({
    graph,
    graphName: options.graphName,
    limit,
    period: input.period,
    preset,
  });
}

function buildGraphQueryResult(input: {
  graph: GraphPresetReadResult;
  graphName: string;
  limit: number;
  period: GraphPeriodFilter;
  preset: GraphPreset;
}): GraphQueryResult {
  return {
    edges: input.graph.edges,
    nodes: input.graph.nodes,
    truncated: input.graph.truncated,
    documentCount: countGraphDocumentNodes(input.graph.nodes),
    graphName: input.graphName,
    limit: input.limit,
    ...(input.period.periodStart ? { periodStart: input.period.periodStart } : {}),
    ...(input.period.periodEnd ? { periodEnd: input.period.periodEnd } : {}),
    preset: {
      defaultLimit: input.preset.defaultLimit,
      description: input.preset.description,
      id: input.preset.id,
      label: input.preset.label,
      maxLimit: input.preset.maxLimit,
      preview: input.graph.preview,
    },
    rawRows: input.graph.rawRows,
    rowCount: input.graph.rowCount,
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
 * @returns A relational repository that loads document chunks and looks up project graph access.
 */
export function createPostgresGraphViewerRepository(
  sql: postgres.Sql = getRequiredAdminSql(),
): GraphViewerRepository {
  return {
    async selectEligibleDocumentGraphNodeIds({ limit, periodEnd, periodStart, projectId }) {
      return sql.begin(async (transaction) => {
        await transaction`SET TRANSACTION READ ONLY`;
        await transaction`SET LOCAL statement_timeout = '5000ms'`;
        const rows: readonly unknown[] = await transaction`
          SELECT graph_node_id
          FROM public.documents
          WHERE project_id = ${projectId}
            AND graph_node_id IS NOT NULL
            AND btrim(graph_node_id) <> ''
            AND (${periodStart ?? null}::date IS NULL OR occurred_at >= ${periodStart ?? null}::date)
            AND (
              ${periodEnd ?? null}::date IS NULL
              OR occurred_at < (${periodEnd ?? null}::date + 1)
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

/** Composes the provider-neutral graph reader with Graph Viewer relational capabilities. */
export function createPostgresGraphViewerDependencies(sql: postgres.Sql = getRequiredAdminSql()): {
  readonly graphReadRepository: GraphReadRepository;
  readonly repository: GraphViewerRepository;
} {
  return {
    graphReadRepository: createPostgresAgeGraphReadRepository(sql),
    repository: createPostgresGraphViewerRepository(sql),
  };
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

function parseEligibleDocumentGraphNodeIdRow(row: unknown): string {
  if (!isRecord(row)) {
    throw new Error('Invalid eligible document row.');
  }
  const graphNodeId = requireString(row.graph_node_id, 'document graph_node_id');
  if (graphNodeId.trim() === '') {
    throw new Error('Invalid document graph_node_id.');
  }
  return graphNodeId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
