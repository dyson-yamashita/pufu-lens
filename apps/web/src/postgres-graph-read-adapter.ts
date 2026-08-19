import { createHash } from 'node:crypto';
import {
  GRAPH_RELATED_DOCUMENT_POOL_LIMITS,
  type GraphPresetId,
  type GraphPresetReadResult,
  type GraphReadEdge,
  type GraphReadNode,
  type GraphReadRepository,
  type GraphRelatedDocumentCandidate,
  type GraphRelatedRelationType,
  parseGraphCountResult,
  parseGraphPresetId,
  parseGraphPresetReadResult,
  parseGraphRelatedDocumentCandidate,
  parseGraphRelationTypes,
} from '@pufu-lens/graph';
import { validateGraphName } from '@pufu-lens/project-tenancy';
import type postgres from 'postgres';
import { graphPropertyString as propertyString } from './graph-property-utils.ts';

const GRAPH_PRESET_MAX_EDGES = 500;
const GRAPH_PRESET_MAX_NODES = 600;

type GraphPresetDefinition = {
  readonly body: string;
  readonly recordDefinition: string;
};

const GRAPH_PRESETS: Readonly<Record<GraphPresetId, GraphPresetDefinition>> = {
  'actor-documents': {
    body: [
      'MATCH (source:Actor)-[relation]->(target:Document)',
      'WHERE target.graphNodeId IN $documentGraphNodeIds',
      'RETURN source, relation, target',
    ].join(' '),
    recordDefinition: 'source agtype, relation agtype, target agtype',
  },
  'recent-relations': {
    body: [
      'MATCH (doc:Document)',
      'WHERE doc.graphNodeId IN $documentGraphNodeIds',
      'MATCH (doc)-[relation]-(neighbor)',
      "WHERE 'Actor' IN labels(neighbor) OR 'Topic' IN labels(neighbor)",
      "OR ('Document' IN labels(neighbor) AND neighbor.graphNodeId IN $documentGraphNodeIds AND doc.graphNodeId <= neighbor.graphNodeId)",
      'RETURN doc AS source, relation, neighbor AS target',
    ].join(' '),
    recordDefinition: 'source agtype, relation agtype, target agtype',
  },
};

/** Returns the bounded provider-owned preview retained by the existing Graph API. */
export function ageGraphPresetPreview(presetId: GraphPresetId): string {
  return `${GRAPH_PRESETS[presetId].body} LIMIT ${GRAPH_PRESET_MAX_EDGES}`;
}

/** Creates the PostgreSQL + Apache AGE implementation of provider-neutral graph reads. */
export function createPostgresAgeGraphReadRepository(sql: postgres.Sql): GraphReadRepository {
  return {
    async findRelatedDocuments(input) {
      const seedDocumentIds = [...new Set(input.seedDocumentIds)].slice(0, 10);
      if (seedDocumentIds.length === 0) {
        return { candidates: [], status: 'success' };
      }
      try {
        const graphName = await resolveProjectGraphName(sql, input.projectId);
        if (!graphName) {
          return { candidates: [], status: 'unavailable' };
        }
        const candidates = await queryRelatedDocumentCandidates(sql, {
          graphName,
          projectId: input.projectId,
          relationLimits: input.relationLimits,
          seedDocumentIds,
        });
        return { candidates, status: 'success' };
      } catch {
        return { candidates: [], status: 'unavailable' };
      }
    },
    async readPreset(input) {
      const presetId = parseGraphPresetId(input.presetId);
      const graphName = await requireProjectGraphName(sql, input.projectId);
      const preset = GRAPH_PRESETS[presetId];
      const preview = ageGraphPresetPreview(presetId);
      if (input.documentGraphNodeIds.length === 0) {
        return parseGraphPresetReadResult({
          edges: [],
          nodes: [],
          preview,
          rawRows: [],
          rowCount: 0,
          truncated: false,
        });
      }
      const rows = await sql.begin(async (transaction) => {
        await configureAgeReadTransaction(transaction);
        return transaction.unsafe(
          `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(
            preview,
          )}, $1::agtype) AS (${preset.recordDefinition})`,
          [JSON.stringify({ documentGraphNodeIds: input.documentGraphNodeIds })],
        ) as Promise<readonly Record<string, unknown>[]>;
      });
      const normalized = normalizeAgeGraphRows(rows, {
        maxEdges: GRAPH_PRESET_MAX_EDGES,
        maxNodes: GRAPH_PRESET_MAX_NODES,
      });
      return parseGraphPresetReadResult({
        ...normalized,
        preview,
        rawRows: rows.map(safeRawRow),
        rowCount: rows.length,
      });
    },
    async countDocumentNode(input) {
      const graphName = await requireProjectGraphName(sql, input.projectId);
      const rows = await queryAgeCount(sql, {
        cypher: 'MATCH (node:Document {graphNodeId: $graphNodeId}) RETURN count(node) AS nodeCount',
        graphName,
        graphNodeId: input.graphNodeId,
      });
      return parseAgeCountRows(rows, 'nodeCount');
    },
    async countRelations(input) {
      const relationTypes = parseGraphRelationTypes(input.relationTypes);
      const graphName = await requireProjectGraphName(sql, input.projectId);
      const counts: Record<string, number> = {};
      await sql.begin(async (transaction) => {
        await configureAgeReadTransaction(transaction);
        for (const relationType of relationTypes) {
          const rows = (await transaction.unsafe(
            `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(
              [
                'MATCH (node:Document {graphNodeId: $graphNodeId})',
                `MATCH (node)-[relation:${relationType}]-()`,
                'RETURN count(relation) AS relationCount',
              ].join(' '),
            )}, $1::agtype) AS (value agtype)`,
            [JSON.stringify({ graphNodeId: input.graphNodeId })],
          )) as readonly unknown[];
          counts[relationType] = parseAgeCountRows(rows, 'relationCount');
        }
      });
      return counts;
    },
  };
}

async function resolveProjectGraphName(
  sql: postgres.Sql,
  projectId: string,
): Promise<string | undefined> {
  const rows = (await sql`
    SELECT graph_name AS "graphName"
    FROM public.projects
    WHERE id = ${projectId}::uuid
    LIMIT 1
  `) as readonly unknown[];
  if (rows.length === 0) {
    return undefined;
  }
  const row = rows[0];
  if (!isRecord(row) || (row.graphName !== null && typeof row.graphName !== 'string')) {
    throw new Error('Invalid project graph capability row.');
  }
  if (row.graphName === null || row.graphName.trim() === '') {
    return undefined;
  }
  return validateGraphName(row.graphName);
}

async function requireProjectGraphName(sql: postgres.Sql, projectId: string): Promise<string> {
  const graphName = await resolveProjectGraphName(sql, projectId);
  if (!graphName) {
    throw new Error('Graph read capability unavailable.');
  }
  return graphName;
}

async function queryRelatedDocumentCandidates(
  sql: postgres.Sql,
  input: {
    readonly graphName: string;
    readonly projectId: string;
    readonly relationLimits?: Partial<Record<GraphRelatedRelationType, number>>;
    readonly seedDocumentIds: readonly string[];
  },
): Promise<readonly GraphRelatedDocumentCandidate[]> {
  const relationLimits = { ...GRAPH_RELATED_DOCUMENT_POOL_LIMITS, ...input.relationLimits };
  const projectIdLiteral = cypherString(input.projectId);
  const seedIdList = input.seedDocumentIds.map(cypherString).join(', ');
  const whereBase = `seed.projectId = ${projectIdLiteral}
  AND related.projectId = ${projectIdLiteral}
  AND seed.documentId IN [${seedIdList}]
  AND NOT related.documentId IN [${seedIdList}]`;
  const relationQueries: readonly {
    readonly cypher: string;
    readonly hopCount: 1 | 2;
    readonly relationType: GraphRelatedRelationType;
  }[] = [
    {
      cypher: `MATCH (seed:Document)-[:SAME_AS]-(related:Document)
WHERE ${whereBase}
RETURN seed, related
ORDER BY seed.documentId, related.documentId`,
      hopCount: 1,
      relationType: 'SAME_AS',
    },
    {
      cypher: `MATCH (seed:Document)-[:RELATED_TO]-(related:Document)
WHERE ${whereBase}
RETURN seed, related
ORDER BY seed.documentId, related.documentId`,
      hopCount: 1,
      relationType: 'RELATED_TO',
    },
    {
      cypher: `MATCH (seed:Document)-[:MENTIONS]-(topic:Topic)-[:MENTIONS]-(related:Document)
WHERE seed.projectId = ${projectIdLiteral}
  AND topic.projectId = ${projectIdLiteral}
  AND related.projectId = ${projectIdLiteral}
  AND seed.documentId IN [${seedIdList}]
  AND NOT related.documentId IN [${seedIdList}]
RETURN seed, related
ORDER BY seed.documentId, related.documentId`,
      hopCount: 2,
      relationType: 'MENTIONS',
    },
  ];
  const candidates: GraphRelatedDocumentCandidate[] = [];
  await sql.begin(async (transaction) => {
    await configureAgeReadTransaction(transaction);
    for (const query of relationQueries) {
      const limit = graphRelationQueryRowLimit(
        relationLimits[query.relationType],
        input.seedDocumentIds.length,
      );
      const rows = (await transaction.unsafe(
        `SELECT * FROM cypher(${sqlString(input.graphName)}, ${dollarQuote(
          `${query.cypher}\nLIMIT ${limit}`,
        )}) AS (seed agtype, related agtype)`,
      )) as readonly unknown[];
      candidates.push(
        ...selectRelatedDocumentCandidates({
          hopCount: query.hopCount,
          limit: relationLimits[query.relationType],
          relationType: query.relationType,
          rows,
        }),
      );
    }
  });
  return candidates;
}

function selectRelatedDocumentCandidates(input: {
  readonly hopCount: 1 | 2;
  readonly limit: number;
  readonly relationType: GraphRelatedRelationType;
  readonly rows: readonly unknown[];
}): GraphRelatedDocumentCandidate[] {
  const candidates: GraphRelatedDocumentCandidate[] = [];
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (candidates.length >= input.limit) break;
    if (!isRecord(row)) continue;
    const seedDocumentId = documentIdFromAgeVertex(row.seed);
    const documentId = documentIdFromAgeVertex(row.related);
    if (!seedDocumentId || !documentId || seen.has(documentId)) continue;
    seen.add(documentId);
    candidates.push(
      parseGraphRelatedDocumentCandidate({
        documentId,
        hopCount: input.hopCount,
        relationType: input.relationType,
        seedDocumentId,
      }),
    );
  }
  return candidates;
}

/** Oversamples AGE rows so per-relation unique pools survive multi-seed duplicate rows. */
export function graphRelationQueryRowLimit(
  relationLimit: number,
  seedDocumentCount: number,
): number {
  return Math.min(Math.max(1, relationLimit) * Math.max(1, seedDocumentCount), 50);
}

export interface GraphRelatedDocumentRows {
  readonly hopCount: 1 | 2;
  readonly relationType: GraphRelatedRelationType;
  readonly rows: readonly unknown[];
}

/** Selects bounded, deduplicated related-document candidates from raw AGE rows. */
export function selectGraphRelatedDocumentCandidates(input: {
  readonly relationLimits?: Partial<Record<GraphRelatedRelationType, number>>;
  readonly relationRows: readonly GraphRelatedDocumentRows[];
}): GraphRelatedDocumentCandidate[] {
  const relationLimits = { ...GRAPH_RELATED_DOCUMENT_POOL_LIMITS, ...input.relationLimits };
  return input.relationRows.flatMap((relationRows) =>
    selectRelatedDocumentCandidates({
      hopCount: relationRows.hopCount,
      limit: relationLimits[relationRows.relationType],
      relationType: relationRows.relationType,
      rows: relationRows.rows,
    }),
  );
}

async function queryAgeCount(
  sql: postgres.Sql,
  input: { readonly cypher: string; readonly graphName: string; readonly graphNodeId: string },
): Promise<readonly unknown[]> {
  return sql.begin(async (transaction) => {
    await configureAgeReadTransaction(transaction);
    return (await transaction.unsafe(
      `SELECT * FROM cypher(${sqlString(input.graphName)}, ${dollarQuote(
        input.cypher,
      )}, $1::agtype) AS (value agtype)`,
      [JSON.stringify({ graphNodeId: input.graphNodeId })],
    )) as readonly unknown[];
  });
}

async function configureAgeReadTransaction(transaction: postgres.TransactionSql): Promise<void> {
  await transaction`SET TRANSACTION READ ONLY`;
  await transaction`LOAD 'age'`;
  await transaction`SET LOCAL search_path = ag_catalog, "$user", public`;
  await transaction`SET LOCAL statement_timeout = '5000ms'`;
}

function parseAgeCountRows(rows: readonly unknown[], label: string): number {
  if (rows.length !== 1 || !isRecord(rows[0])) {
    throw new Error(`Invalid graph ${label} result.`);
  }
  const value = rows[0].value;
  if (typeof value === 'number') return parseGraphCountResult(value);
  if (typeof value === 'bigint') return parseGraphCountResult(Number(value));
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return parseGraphCountResult(Number(value.trim()));
  }
  throw new Error(`Invalid graph ${label} result.`);
}

/** Normalizes bounded raw AGE rows for adapter parity tests and Viewer responses. */
export function normalizeAgeGraphRows(
  rows: readonly Record<string, unknown>[],
  limits: { readonly maxEdges: number; readonly maxNodes: number },
): Pick<GraphPresetReadResult, 'edges' | 'nodes' | 'truncated'> {
  const nodes = new Map<string, GraphReadNode>();
  const edges = new Map<string, GraphReadEdge>();
  let truncated = false;
  for (const row of rows) {
    for (const value of Object.values(row)) {
      collectGraphValue(value, {
        edges,
        limits,
        nodes,
        truncated: () => (truncated = true),
      });
    }
  }
  return { edges: [...edges.values()], nodes: [...nodes.values()], truncated };
}

function collectGraphValue(
  value: unknown,
  state: {
    readonly edges: Map<string, GraphReadEdge>;
    readonly limits: { readonly maxEdges: number; readonly maxNodes: number };
    readonly nodes: Map<string, GraphReadNode>;
    readonly truncated: () => void;
  },
): void {
  const parsed = parseGraphValue(value);
  if (!parsed) return;
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectGraphValue(item, state);
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

function parseGraphValue(value: unknown): GraphReadNode | GraphReadEdge | unknown[] | undefined {
  if (typeof value === 'string') return parseTypedAgtype(value.trim());
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return undefined;
  if (isParsedNode(value) || isParsedEdge(value)) return value;
  if (isAgeVertexRecord(value)) return vertexRecordToNode(value);
  if (isAgeEdgeRecord(value)) return edgeRecordToEdge(value);
  if (Array.isArray(value.vertices) || Array.isArray(value.edges)) {
    return [
      ...((value.vertices as unknown[] | undefined) ?? []),
      ...((value.edges as unknown[] | undefined) ?? []),
    ];
  }
  return undefined;
}

function parseTypedAgtype(value: string): GraphReadNode | GraphReadEdge | unknown[] | undefined {
  if (!value) return undefined;
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
  return value.endsWith('::path') ? parsePathItems(value.slice(0, -'::path'.length)) : undefined;
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
    if (inString) continue;
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== '}') continue;
    depth -= 1;
    if (depth < 0) {
      depth = 0;
      start = -1;
      continue;
    }
    if (depth === 0 && start !== -1) {
      const suffix = value.slice(index + 1).match(/^::(?:vertex|edge)/)?.[0];
      if (suffix) {
        const parsed = parseTypedAgtype(`${value.slice(start, index + 1)}${suffix}`);
        if (parsed) items.push(parsed);
        index += suffix.length;
      }
      start = -1;
    }
  }
  return items;
}

function vertexRecordToNode(value: Record<string, unknown>): GraphReadNode {
  const id = String(value.id ?? value.graphNodeId ?? value.graph_node_id ?? '');
  const label = String(value.label ?? 'Node');
  const properties = isRecord(value.properties) ? value.properties : {};
  const graphNodeId =
    propertyString(properties, 'graphNodeId') ?? propertyString(properties, 'graph_node_id');
  return {
    id,
    label: displayNodeLabel(label, properties),
    labels: [label],
    properties: { ...properties, ageId: id, ...(graphNodeId ? { graphNodeId } : {}) },
  };
}

function edgeRecordToEdge(value: Record<string, unknown>): GraphReadEdge {
  return {
    id: String(value.id ?? stableId(value)),
    label: String(value.label ?? 'RELATED'),
    properties: isRecord(value.properties) ? value.properties : {},
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

function documentIdFromAgeVertex(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.endsWith('::vertex')) return undefined;
  try {
    const parsed = JSON.parse(value.slice(0, -'::vertex'.length)) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.properties)) return undefined;
    const documentId = parsed.properties.documentId;
    return typeof documentId === 'string' && documentId ? documentId : undefined;
  } catch {
    return undefined;
  }
}

function safeRawRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, rawValuePreview(value)]),
  );
}

function rawValuePreview(value: unknown): unknown {
  if (typeof value === 'string')
    return value.length > 2_000 ? `${value.slice(0, 2_000)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(rawValuePreview);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, nested]) => [key, rawValuePreview(nested)]),
    );
  }
  return value;
}

function isEscaped(value: string, index: number): boolean {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1)
    backslashCount += 1;
  return backslashCount % 2 === 1;
}

function isAgeVertexRecord(value: Record<string, unknown>): boolean {
  return 'id' in value && 'label' in value && 'properties' in value && !('start_id' in value);
}

function isAgeEdgeRecord(value: Record<string, unknown>): boolean {
  return 'id' in value && 'label' in value && 'start_id' in value && 'end_id' in value;
}

function isParsedNode(value: unknown): value is GraphReadNode {
  return isRecord(value) && typeof value.id === 'string' && Array.isArray(value.labels);
}

function isParsedEdge(value: unknown): value is GraphReadEdge {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.source === 'string' &&
    typeof value.target === 'string'
  );
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

function cypherString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
