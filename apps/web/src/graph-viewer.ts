import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { getRequiredAdminSql } from './admin-sql.ts';

export type GraphPresetId = 'actor-documents' | 'recent-relations' | 'same-as';

export type GraphPresetSummary = {
  readonly description: string;
  readonly id: GraphPresetId;
  readonly label: string;
  readonly preview: string;
};

export type GraphViewerNode = {
  readonly id: string;
  readonly label: string;
  readonly labels: readonly string[];
  readonly properties: Record<string, unknown>;
};

export type GraphViewerEdge = {
  readonly id: string;
  readonly label: string;
  readonly properties: Record<string, unknown>;
  readonly source: string;
  readonly target: string;
};

export type GraphQueryResult = {
  readonly edges: readonly GraphViewerEdge[];
  readonly graphName: string;
  readonly nodes: readonly GraphViewerNode[];
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

type GraphPreset = GraphPresetSummary & {
  readonly cypher: string;
  readonly maxEdges: number;
  readonly maxNodes: number;
  readonly recordDefinition: string;
  readonly rowLimit: number;
};

export interface GraphViewerRepository {
  executePreset(input: {
    graphName: string;
    preset: GraphPreset;
  }): Promise<readonly Record<string, unknown>[]>;
  lookupProjectMember(input: {
    projectSlug: string;
    userId: string;
  }): Promise<GraphProjectAccess | undefined>;
}

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

export const GRAPH_PRESETS: readonly GraphPreset[] = [
  {
    cypher: `MATCH (source)-[relation]->(target)
RETURN source, relation, target
LIMIT 100`,
    description: 'Document、Actor、Topic など、直近の関係を横断して確認します。',
    id: 'recent-relations',
    label: 'Recent Relations',
    maxEdges: 100,
    maxNodes: 120,
    preview: `MATCH (source)-[relation]->(target)
RETURN source, relation, target
LIMIT 100`,
    recordDefinition: 'source agtype, relation agtype, target agtype',
    rowLimit: 100,
  },
  {
    cypher: `MATCH (source:Actor)-[relation]->(target:Document)
RETURN source, relation, target
LIMIT 100`,
    description: 'Actor から Document への関係を確認します。',
    id: 'actor-documents',
    label: 'Actors to Documents',
    maxEdges: 100,
    maxNodes: 120,
    preview: `MATCH (source:Actor)-[relation]->(target:Document)
RETURN source, relation, target
LIMIT 100`,
    recordDefinition: 'source agtype, relation agtype, target agtype',
    rowLimit: 100,
  },
  {
    cypher: `MATCH (source)-[relation:SAME_AS]->(target)
RETURN source, relation, target
LIMIT 100`,
    description: '重複・同一実体候補の SAME_AS 関係を確認します。',
    id: 'same-as',
    label: 'SAME_AS',
    maxEdges: 100,
    maxNodes: 120,
    preview: `MATCH (source)-[relation:SAME_AS]->(target)
RETURN source, relation, target
LIMIT 100`,
    recordDefinition: 'source agtype, relation agtype, target agtype',
    rowLimit: 100,
  },
];

export function listGraphPresets(): readonly GraphPresetSummary[] {
  return GRAPH_PRESETS.map(({ description, id, label, preview }) => ({
    description,
    id,
    label,
    preview,
  }));
}

export function getGraphPreset(queryId: string): GraphPreset {
  const preset = GRAPH_PRESETS.find((candidate) => candidate.id === queryId);
  if (!preset) {
    throw new GraphPresetNotFoundError(queryId);
  }
  return preset;
}

export async function runGraphPresetQuery(
  input: { projectSlug: string; queryId: string; userId: string },
  options: { repository: GraphViewerRepository },
): Promise<GraphQueryResult> {
  const preset = getGraphPreset(input.queryId);
  const project = await options.repository.lookupProjectMember({
    projectSlug: input.projectSlug,
    userId: input.userId,
  });
  if (!project) {
    throw new GraphAccessDeniedError(input.projectSlug);
  }

  const rows = await options.repository.executePreset({
    graphName: project.graphName,
    preset,
  });
  const normalized = normalizeGraphRows(rows, {
    maxEdges: preset.maxEdges,
    maxNodes: preset.maxNodes,
  });

  return {
    ...normalized,
    graphName: project.graphName,
    preset: {
      description: preset.description,
      id: preset.id,
      label: preset.label,
      preview: preset.preview,
    },
    rawRows: rows.map(safeRawRow),
    rowCount: rows.length,
  };
}

export function createPostgresGraphViewerRepository(
  sql: postgres.Sql = getRequiredAdminSql(),
): GraphViewerRepository {
  return {
    async executePreset({ graphName, preset }) {
      const safeGraphName = validateGraphName(graphName);
      const safeRecordDefinition = validateRecordDefinition(preset.recordDefinition);
      return sql.begin(async (transaction) => {
        await transaction`SET TRANSACTION READ ONLY`;
        await transaction`LOAD 'age'`;
        await transaction`SET LOCAL search_path = ag_catalog, "$user", public`;
        await transaction`SET LOCAL statement_timeout = '5000ms'`;
        return transaction.unsafe(
          `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
            preset.cypher,
          )}) AS (${safeRecordDefinition})`,
        ) as Promise<readonly Record<string, unknown>[]>;
      });
    },
    async lookupProjectMember({ projectSlug, userId }) {
      const rows = (await sql`
        SELECT
          p.id::text AS id,
          p.slug,
          p.name,
          p.graph_name AS graph_name
        FROM public.projects p
        JOIN public.users app_user
          ON app_user.id = ${userId}
        LEFT JOIN public.project_members pm
          ON pm.project_id = p.id
         AND pm.user_id = app_user.id
        WHERE p.slug = ${projectSlug}
          AND (app_user.role = 'admin' OR pm.user_id IS NOT NULL)
      `) as Array<{
        graph_name: string;
        id: string;
        name: string;
        slug: string;
      }>;
      const row = rows[0];
      return row
        ? {
            graphName: validateGraphName(row.graph_name),
            id: row.id,
            name: row.name,
            slug: row.slug,
          }
        : undefined;
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
  if (value.endsWith('::path')) {
    const body = value.slice(0, -'::path'.length);
    return parsePathItems(body);
  }
  return undefined;
}

function parsePathItems(value: string): unknown[] {
  const items: unknown[] = [];
  const pattern = /(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}::(?:vertex|edge))/g;
  for (const match of value.matchAll(pattern)) {
    const parsed = parseTypedAgtype(match[1] ?? '');
    if (parsed) {
      items.push(parsed);
    }
  }
  return items;
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
    propertyString(properties, 'graphNodeId') ??
    label
  );
}

function propertyString(properties: Record<string, unknown>, key: string): string | undefined {
  const value = properties[key];
  return typeof value === 'string' && value ? value : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
