import { validateGraphName } from './cli.ts';
import {
  type GraphInventory,
  type GraphInventoryEdge,
  type GraphInventoryNode,
  normalizeStructuralStringSet,
} from './graph-migration-audit.ts';
import type { PostgresGraphExecutor } from './postgres-graph-indexing-adapter.ts';

export const MAX_GRAPH_INVENTORY_LIMIT = 100_000;

const AGE_GRAPH_NODE_ID_SCALAR_SQL = "ag_catalog.agtype_to_json(graph_node_id) #>> '{}'";

/** Validates inventory query limits before any provider SQL executes. */
export function validateGraphInventoryLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new Error('Graph inventory limit must be a positive integer.');
  }
  if (limit > MAX_GRAPH_INVENTORY_LIMIT) {
    throw new Error('Graph inventory limit exceeds maximum.');
  }
  return limit;
}

/** Reads a bounded, sanitized AGE graph inventory for one project. */
export async function readAgeGraphInventory(
  sql: PostgresGraphExecutor,
  projectId: string,
  limit: number,
): Promise<GraphInventory> {
  const validatedLimit = validateGraphInventoryLimit(limit);
  const graphName = await resolveValidatedProjectGraphName(sql, projectId);
  if (!graphName) {
    return { edges: [], nodes: [], truncated: false };
  }
  await ensureAgeSession(sql);
  const nodeLimit = validatedLimit + 1;
  const edgeLimit = validatedLimit + 1;
  const nodeRows = (await sql.unsafe(
    `SELECT identity_digest, labels_json, graph_labels_json, property_keys_json
     FROM (
       SELECT
         encode(sha256(convert_to(${AGE_GRAPH_NODE_ID_SCALAR_SQL}, 'UTF8')), 'hex') AS identity_digest,
         ag_catalog.agtype_to_json(node_labels) AS labels_json,
         ag_catalog.agtype_to_json(graph_labels) AS graph_labels_json,
         ag_catalog.agtype_to_json(property_keys) AS property_keys_json
       FROM cypher(${sqlString(graphName)}, ${dollarQuote(
         'MATCH (n) RETURN n.graphNodeId, labels(n), keys(n), n.graphLabels',
       )}) AS (graph_node_id agtype, node_labels agtype, property_keys agtype, graph_labels agtype)
       LIMIT ${nodeLimit}
     ) inventory_nodes`,
  )) as readonly unknown[];
  const edgeRows = (await sql.unsafe(
    `SELECT source_identity_digest, target_identity_digest, relation_type, property_keys_json
     FROM (
       SELECT
         encode(sha256(convert_to(ag_catalog.agtype_to_json(source_graph_node_id) #>> '{}', 'UTF8')), 'hex') AS source_identity_digest,
         encode(sha256(convert_to(ag_catalog.agtype_to_json(target_graph_node_id) #>> '{}', 'UTF8')), 'hex') AS target_identity_digest,
         ag_catalog.agtype_to_json(relation_type) #>> '{}' AS relation_type,
         ag_catalog.agtype_to_json(property_keys) AS property_keys_json
       FROM cypher(${sqlString(graphName)}, ${dollarQuote(
         'MATCH (a)-[r]->(b) RETURN a.graphNodeId, b.graphNodeId, type(r), keys(r)',
       )}) AS (source_graph_node_id agtype, target_graph_node_id agtype, relation_type agtype, property_keys agtype)
       LIMIT ${edgeLimit}
     ) inventory_edges`,
  )) as readonly unknown[];

  const nodes = nodeRows.slice(0, validatedLimit).map(parseAgeInventoryNodeRow);
  const edges = edgeRows.slice(0, validatedLimit).map(parseAgeInventoryEdgeRow);
  return {
    edges,
    nodes,
    truncated: nodeRows.length > validatedLimit || edgeRows.length > validatedLimit,
  };
}

/** Reads a bounded, sanitized relational graph inventory for one project. */
export async function readRelationalGraphInventory(
  sql: PostgresGraphExecutor,
  projectId: string,
  limit: number,
): Promise<GraphInventory> {
  const validatedLimit = validateGraphInventoryLimit(limit);
  const nodeLimit = validatedLimit + 1;
  const edgeLimit = validatedLimit + 1;
  const nodeRows = (await sql`
    SELECT
      encode(sha256(convert_to(node_key, 'UTF8')), 'hex') AS "identityDigest",
      kind,
      subtype,
      COALESCE(
        (
          SELECT jsonb_agg(label_value ORDER BY label_value)
          FROM jsonb_array_elements_text(COALESCE(properties -> 'graphLabels', '[]'::jsonb)) AS label_value
        ),
        '[]'::jsonb
      ) AS "labels",
      COALESCE(
        (
          SELECT jsonb_agg(property_key ORDER BY property_key)
          FROM jsonb_object_keys(properties) AS property_key
          WHERE property_key <> 'graphLabels'
        ),
        '[]'::jsonb
      ) AS "propertyKeys"
    FROM public.graph_nodes
    WHERE project_id = ${projectId}::uuid
    ORDER BY encode(sha256(convert_to(node_key, 'UTF8')), 'hex')
    LIMIT ${nodeLimit}
  `) as readonly unknown[];
  const edgeRows = (await sql`
    SELECT
      encode(sha256(convert_to(source_node_key, 'UTF8')), 'hex') AS "sourceIdentityDigest",
      encode(sha256(convert_to(target_node_key, 'UTF8')), 'hex') AS "targetIdentityDigest",
      relation_type AS "relationType",
      COALESCE(
        (
          SELECT jsonb_agg(property_key ORDER BY property_key)
          FROM jsonb_object_keys(properties) AS property_key
        ),
        '[]'::jsonb
      ) AS "propertyKeys"
    FROM public.graph_edges
    WHERE project_id = ${projectId}::uuid
    ORDER BY
      encode(sha256(convert_to(source_node_key, 'UTF8')), 'hex'),
      relation_type,
      encode(sha256(convert_to(target_node_key, 'UTF8')), 'hex')
    LIMIT ${edgeLimit}
  `) as readonly unknown[];

  const nodes = nodeRows.slice(0, validatedLimit).map(parseRelationalInventoryNodeRow);
  const edges = edgeRows.slice(0, validatedLimit).map(parseRelationalInventoryEdgeRow);
  return {
    edges,
    nodes,
    truncated: nodeRows.length > validatedLimit || edgeRows.length > validatedLimit,
  };
}

/**
 * Builds normalized structural labels for AGE inventory from physical labels and graphLabels property.
 * Missing or null graphLabels falls back to physical labels only; malformed graphLabels fails closed.
 */
export function parseAgeInventoryStructuralLabels(
  physicalLabels: unknown,
  graphLabelsProperty: unknown,
): readonly string[] {
  const physical = normalizeStructuralStringSet(parseStringArray(physicalLabels));
  const graphLabels = parseOptionalGraphLabelsProperty(graphLabelsProperty);
  if (graphLabels === null) {
    return physical;
  }
  return normalizeStructuralStringSet([...physical, ...graphLabels]);
}

function parseAgeInventoryNodeRow(row: unknown): GraphInventoryNode {
  if (!isRecord(row)) {
    throw new Error('Invalid AGE inventory node row.');
  }
  return {
    identityDigest: requireDigest(row.identity_digest ?? row.identityDigest),
    labels: parseAgeInventoryStructuralLabels(
      row.labels_json ?? row.labels,
      row.graph_labels_json ?? row.graphLabels,
    ),
    propertyKeys: normalizeStructuralStringSet(
      parseStringArray(row.property_keys_json ?? row.propertyKeys).filter(
        (key) => key !== 'graphLabels',
      ),
    ),
  };
}

function parseOptionalGraphLabelsProperty(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'string' ? parseJsonValue(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid AGE inventory graphLabels property.');
  }
  return parsed.map((entry) => requireNonEmptyString(entry, 'graphLabels entry'));
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('Invalid AGE inventory graphLabels property.');
  }
}

function parseAgeInventoryEdgeRow(row: unknown): GraphInventoryEdge {
  if (!isRecord(row)) {
    throw new Error('Invalid AGE inventory edge row.');
  }
  return {
    propertyKeys: normalizeStructuralStringSet(
      parseStringArray(row.property_keys_json ?? row.propertyKeys),
    ),
    relationType: requireNonEmptyString(row.relation_type ?? row.relationType, 'relationType'),
    sourceIdentityDigest: requireDigest(row.source_identity_digest ?? row.sourceIdentityDigest),
    targetIdentityDigest: requireDigest(row.target_identity_digest ?? row.targetIdentityDigest),
  };
}

function parseRelationalInventoryNodeRow(row: unknown): GraphInventoryNode {
  if (!isRecord(row)) {
    throw new Error('Invalid relational inventory node row.');
  }
  return {
    identityDigest: requireDigest(row.identityDigest),
    labels: normalizeStructuralStringSet(parseStringArray(row.labels)),
    propertyKeys: normalizeStructuralStringSet(parseStringArray(row.propertyKeys)),
  };
}

function parseRelationalInventoryEdgeRow(row: unknown): GraphInventoryEdge {
  if (!isRecord(row)) {
    throw new Error('Invalid relational inventory edge row.');
  }
  return {
    propertyKeys: normalizeStructuralStringSet(parseStringArray(row.propertyKeys)),
    relationType: requireNonEmptyString(row.relationType, 'relationType'),
    sourceIdentityDigest: requireDigest(row.sourceIdentityDigest),
    targetIdentityDigest: requireDigest(row.targetIdentityDigest),
  };
}

function parseStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error('Invalid inventory string array.');
    }
    return parsed.map((entry) => requireNonEmptyString(entry, 'inventory array entry'));
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid inventory string array.');
  }
  return value.map((entry) => requireNonEmptyString(entry, 'inventory array entry'));
}

function requireDigest(value: unknown): string {
  const digest = requireNonEmptyString(value, 'identityDigest');
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('Invalid identity digest.');
  }
  return digest;
}

async function resolveValidatedProjectGraphName(
  sql: PostgresGraphExecutor,
  projectId: string,
): Promise<string | undefined> {
  const rows = (await sql`
    SELECT graph_name AS "graphName"
    FROM public.projects
    WHERE id = ${projectId}::uuid
    LIMIT 1
  `) as readonly unknown[];
  const row = rows[0];
  if (!isRecord(row)) {
    return undefined;
  }
  const graphName = row.graphName;
  if (graphName === null || typeof graphName !== 'string' || graphName.trim().length === 0) {
    return undefined;
  }
  return validateGraphName(graphName);
}

async function ensureAgeSession(sql: PostgresGraphExecutor): Promise<void> {
  await sql.unsafe("LOAD 'age'");
  await sql.unsafe('SET search_path = ag_catalog, "$user", public');
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function dollarQuote(value: string): string {
  return `$pufu_static$${value}$pufu_static$`;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid graph inventory field: ${fieldName}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
