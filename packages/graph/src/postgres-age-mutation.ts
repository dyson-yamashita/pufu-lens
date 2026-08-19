import { createHash } from 'node:crypto';
import { validateGraphName } from '@pufu-lens/project-tenancy';
import type postgres from 'postgres';
import {
  type GraphActorMergeInput,
  type GraphActorMergeResult,
  type GraphMutationEdgeInput,
  type GraphMutationNodeInput,
  type GraphMutationRepository,
  parseGraphActorMergeInput,
  parseGraphDocumentCleanupInput,
  parseGraphMutationEdgeInput,
  parseGraphMutationNodeInput,
  parseGraphProjectMutationInput,
  requireSafeJsonValue,
} from './index.js';

const ACTOR_EDGE_TYPES = [
  'AUTHORED',
  'COMMENTED_ON',
  'MENTIONS',
  'OWNS',
  'REPLY_TO',
  'REVIEWED',
  'SAME_AS',
  'SENT',
] as const;

type AgeExecutor = postgres.Sql | postgres.TransactionSql;

const GRAPH_MUTATION_UNAVAILABLE_MESSAGE = 'Graph mutation capability unavailable.';

/** Creates the PostgreSQL + Apache AGE implementation of provider-neutral graph mutations. */
export function createPostgresAgeGraphMutationRepository(
  sql: AgeExecutor,
): GraphMutationRepository {
  return {
    async deleteDocumentGraphNodes(input) {
      const parsed = parseGraphDocumentCleanupInput(input);
      if (parsed.graphNodeIds.length === 0) {
        return 0;
      }
      try {
        const graphName = await resolveProjectGraphName(sql, parsed.projectId);
        if (!graphName) {
          return 0;
        }
        return await withAgeSession(sql, async (executor) => {
          const rows = (await executor.unsafe(
            `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(
              'MATCH (n:Document) WHERE n.graphNodeId IN $graphNodeIds WITH collect(n) AS nodes UNWIND nodes AS node DETACH DELETE node RETURN size(nodes) AS deletedCount',
            )}, $1::agtype) AS (value agtype)`,
            [JSON.stringify({ graphNodeIds: parsed.graphNodeIds })],
          )) as readonly unknown[];
          return parseAgeGraphMutationCountRow(rows[0], 'document cleanup deleted count');
        });
      } catch (error) {
        logMutationUnavailable('delete_document_graph_nodes', error);
        return 0;
      }
    },
    async deleteProjectGraph(input) {
      const parsed = parseGraphProjectMutationInput(input);
      try {
        const graphName = await requireProjectGraphName(sql, parsed.projectId);
        await withAgeSession(sql, async (executor) => {
          await executor.unsafe(
            `SELECT drop_graph(${sqlString(graphName)}, true) WHERE EXISTS (
            SELECT 1 FROM ag_catalog.ag_graph WHERE name = ${sqlString(graphName)}
          )`,
          );
        });
      } catch (error) {
        rethrowOrNormalizeMutationError('delete_project_graph', error);
      }
    },
    async ensureProjectGraph(input) {
      const parsed = parseGraphProjectMutationInput(input);
      try {
        const graphName = await requireProjectGraphName(sql, parsed.projectId);
        await withAgeSession(sql, async (executor) => {
          await executor.unsafe(
            `SELECT create_graph(${sqlString(graphName)}) WHERE NOT EXISTS (
            SELECT 1 FROM ag_catalog.ag_graph WHERE name = ${sqlString(graphName)}
          )`,
          );
        });
      } catch (error) {
        rethrowOrNormalizeMutationError('ensure_project_graph', error);
      }
    },
    async mergeActorGraphNodes(input) {
      const parsed = parseGraphActorMergeInput(input);
      try {
        const graphName = await resolveProjectGraphName(sql, parsed.projectId);
        if (!graphName) {
          return { reason: 'project graph is not configured', status: 'skipped' };
        }
        if (parsed.primaryGraphNodeId === parsed.secondaryGraphNodeId) {
          return { reason: 'primary and secondary graph nodes are identical', status: 'skipped' };
        }
        return await withAgeSession(sql, async (executor) =>
          mergeActorGraphNodesInAge(executor, graphName, parsed),
        );
      } catch (error) {
        if (isActorMergeInvariantError(error)) {
          throw error;
        }
        logMutationUnavailable('merge_actor_graph_nodes', error);
        return { status: 'unavailable' };
      }
    },
    async upsertEdge(input) {
      const parsed = parseGraphMutationEdgeInput(input);
      validateUpsertEdgeAdapterInput(parsed);
      try {
        const graphName = await requireProjectGraphName(sql, parsed.projectId);
        await withAgeSession(sql, async (executor) => {
          await upsertGraphEdge(executor, graphName, parsed);
        });
      } catch (error) {
        rethrowOrNormalizeMutationError('upsert_edge', error);
      }
    },
    async upsertNode(input) {
      const parsed = parseGraphMutationNodeInput(input);
      validateUpsertNodeAdapterInput(parsed);
      try {
        const graphName = await requireProjectGraphName(sql, parsed.projectId);
        await withAgeSession(sql, async (executor) => {
          await upsertGraphNode(executor, graphName, parsed);
        });
      } catch (error) {
        rethrowOrNormalizeMutationError('upsert_node', error);
      }
    },
  };
}

/** Parses a single AGE agtype count row returned by graph mutation cypher. */
export function parseAgeGraphMutationCountRow(row: unknown, label: string): number {
  if (!isRecord(row)) {
    throw new Error(`Invalid AGE ${label}.`);
  }
  return parseAgeInteger(row.value, label);
}

async function mergeActorGraphNodesInAge(
  executor: AgeExecutor,
  graphName: string,
  input: GraphActorMergeInput,
): Promise<GraphActorMergeResult> {
  const secondaryCount = await countActorGraphNode(
    executor,
    graphName,
    input.secondaryGraphNodeId,
    'secondary actor graph node',
  );
  if (secondaryCount === 0) {
    return { reason: 'secondary actor graph node not found', status: 'skipped' };
  }
  if (secondaryCount !== 1) {
    throw new Error(`expected 1 secondary actor graph node, found ${secondaryCount}`);
  }
  const primaryCount = await countActorGraphNode(
    executor,
    graphName,
    input.primaryGraphNodeId,
    'primary actor graph node',
  );
  if (primaryCount !== 1) {
    throw new Error(`expected 1 primary actor graph node, found ${primaryCount}`);
  }

  for (const edgeType of ACTOR_EDGE_TYPES) {
    const outgoingRows = (await executor.unsafe(
      `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(
        [
          'MATCH (primary {graphNodeId: $primaryGraphNodeId})',
          'MATCH (secondary {graphNodeId: $secondaryGraphNodeId})',
          `MATCH (secondary)-[relation:${edgeType}]->(target)`,
          'WHERE target.graphNodeId IS NULL OR target.graphNodeId <> $primaryGraphNodeId',
          `OPTIONAL MATCH (primary)-[existing:${edgeType}]->(target)`,
          'WITH primary, target, relation, existing',
          'WHERE existing IS NULL',
          `CREATE (primary)-[merged:${edgeType}]->(target)`,
          'SET merged += properties(relation), merged.actorId = $primaryActorId',
          'RETURN count(merged) AS mergedCount',
        ].join(' '),
      )}, $1::agtype) AS (value agtype)`,
      [JSON.stringify(actorGraphParameters(input))],
    )) as readonly unknown[];
    parseActorGraphOptionalCountRows(outgoingRows, `${edgeType} outgoing merge count`);
    const incomingRows = (await executor.unsafe(
      `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(
        [
          'MATCH (primary {graphNodeId: $primaryGraphNodeId})',
          'MATCH (secondary {graphNodeId: $secondaryGraphNodeId})',
          `MATCH (source)-[relation:${edgeType}]->(secondary)`,
          'WHERE source.graphNodeId IS NULL OR source.graphNodeId <> $primaryGraphNodeId',
          `OPTIONAL MATCH (source)-[existing:${edgeType}]->(primary)`,
          'WITH source, primary, relation, existing',
          'WHERE existing IS NULL',
          `CREATE (source)-[merged:${edgeType}]->(primary)`,
          'SET merged += properties(relation), merged.actorId = $primaryActorId',
          'RETURN count(merged) AS mergedCount',
        ].join(' '),
      )}, $1::agtype) AS (value agtype)`,
      [JSON.stringify(actorGraphParameters(input))],
    )) as readonly unknown[];
    parseActorGraphOptionalCountRows(incomingRows, `${edgeType} incoming merge count`);
  }

  const deleteRows = (await executor.unsafe(
    `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(
      [
        'MATCH (secondary {graphNodeId: $secondaryGraphNodeId})',
        'WITH secondary, count(secondary) AS deletedCount',
        'DETACH DELETE secondary',
        'RETURN deletedCount',
      ].join(' '),
    )}, $1::agtype) AS (value agtype)`,
    [JSON.stringify(actorGraphParameters(input))],
  )) as readonly unknown[];
  const deletedCount = parseAgeGraphMutationCountRow(deleteRows[0], 'secondary actor delete count');
  if (deletedCount !== 1) {
    throw new Error(
      `Actor graph reconcile failed: expected to delete 1 secondary node, deleted ${deletedCount}.`,
    );
  }
  return { deletedCount, status: 'merged' };
}

function isActorMergeInvariantError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /expected 1|Actor graph reconcile failed/.test(error.message);
}

async function upsertGraphNode(
  executor: AgeExecutor,
  graphName: string,
  input: GraphMutationNodeInput,
): Promise<void> {
  const label = validateLabel(input.labels[0] ?? 'Document');
  const properties = {
    ...input.properties,
    graphLabels: input.labels,
    graphNodeId: input.graphNodeId,
  };
  const setClause = parameterizedSetClause('n', properties);
  await executeCypher(
    executor,
    graphName,
    `MERGE (n:${label} {graphNodeId: $graphNodeId}) ${setClause.cypher} RETURN n`,
    { graphNodeId: input.graphNodeId, ...setClause.params },
  );
}

async function upsertGraphEdge(
  executor: AgeExecutor,
  graphName: string,
  input: GraphMutationEdgeInput,
): Promise<void> {
  const edgeType = validateLabel(input.relationType);
  const setClause = parameterizedSetClause('r', input.properties);
  await executeCypher(
    executor,
    graphName,
    [
      'MATCH (from {graphNodeId: $fromGraphNodeId})',
      'MATCH (to {graphNodeId: $toGraphNodeId})',
      `MERGE (from)-[r:${edgeType}]->(to)`,
      setClause.cypher,
      'RETURN r',
    ].join(' '),
    {
      fromGraphNodeId: input.fromGraphNodeId,
      ...setClause.params,
      toGraphNodeId: input.toGraphNodeId,
    },
  );
}

async function resolveProjectGraphName(
  sql: AgeExecutor,
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
  const graphName = parseProjectGraphNameLookupValue(rows[0]);
  if (graphName === null || graphName.trim() === '') {
    return undefined;
  }
  return validateGraphName(graphName);
}

function parseProjectGraphNameLookupValue(row: unknown): string | null {
  if (!isRecord(row)) {
    throw new Error('Invalid project graph lookup row.');
  }
  const keys = Object.keys(row);
  if (keys.length !== 1 || keys[0] !== 'graphName') {
    throw new Error('Invalid project graph lookup row.');
  }
  const graphName = row.graphName;
  if (graphName === null) {
    return null;
  }
  if (typeof graphName !== 'string') {
    throw new Error('Invalid project graph lookup row.');
  }
  return graphName;
}

async function requireProjectGraphName(sql: AgeExecutor, projectId: string): Promise<string> {
  const graphName = await resolveProjectGraphName(sql, projectId);
  if (!graphName) {
    throw createMutationUnavailableError();
  }
  return graphName;
}

function createMutationUnavailableError(): Error {
  return new Error(GRAPH_MUTATION_UNAVAILABLE_MESSAGE);
}

function rethrowOrNormalizeMutationError(operation: string, error: unknown): void {
  throwMutationUnavailable(operation, error);
}

function throwMutationUnavailable(operation: string, error: unknown): void {
  logMutationUnavailable(operation, error);
  throw createMutationUnavailableError();
}

function validateUpsertNodeAdapterInput(input: GraphMutationNodeInput): void {
  validateLabel(input.labels[0] ?? 'Document');
  validatePropertyNames(input.properties);
}

function validateUpsertEdgeAdapterInput(input: GraphMutationEdgeInput): void {
  validatePropertyNames(input.properties);
}

function validatePropertyNames(properties: Record<string, unknown>): void {
  for (const propertyName of Object.keys(properties)) {
    validatePropertyName(propertyName);
  }
}

async function withAgeSession<T>(
  sql: AgeExecutor,
  operation: (executor: AgeExecutor) => Promise<T>,
): Promise<T> {
  if (isSql(sql)) {
    const result = await sql.begin(async (transaction) => {
      await configureAge(transaction);
      return operation(transaction);
    });
    return result as T;
  }
  await configureAge(sql);
  return operation(sql);
}

function isSql(value: AgeExecutor): value is postgres.Sql {
  return typeof (value as postgres.Sql).begin === 'function';
}

async function configureAge(executor: AgeExecutor): Promise<void> {
  await executor`LOAD 'age'`;
  await executor`SET LOCAL search_path = ag_catalog, "$user", public`;
}

async function executeCypher(
  executor: AgeExecutor,
  graphName: string,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  await executor.unsafe(
    `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(cypher)}, $1::agtype) AS (value agtype)`,
    [JSON.stringify(params)],
  );
}

async function countActorGraphNode(
  executor: AgeExecutor,
  graphName: string,
  graphNodeId: string,
  label: string,
): Promise<number> {
  const rows = (await executor.unsafe(
    `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(
      ['MATCH (node {graphNodeId: $graphNodeId})', 'RETURN count(node) AS nodeCount'].join(' '),
    )}, $1::agtype) AS (value agtype)`,
    [JSON.stringify({ graphNodeId })],
  )) as readonly unknown[];
  return parseAgeGraphMutationCountRow(rows[0], label);
}

function actorGraphParameters(input: GraphActorMergeInput): {
  readonly primaryActorId: string;
  readonly primaryGraphNodeId: string;
  readonly secondaryGraphNodeId: string;
} {
  return {
    primaryActorId: input.primaryActorId,
    primaryGraphNodeId: input.primaryGraphNodeId,
    secondaryGraphNodeId: input.secondaryGraphNodeId,
  };
}

function parseActorGraphOptionalCountRows(rows: readonly unknown[], label: string): number {
  if (rows.length === 0) {
    return 0;
  }
  return parseAgeGraphMutationCountRow(rows[0], label);
}

function parseAgeInteger(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  throw new Error(`Invalid AGE ${label}: value is not a safe integer.`);
}

function logMutationUnavailable(operation: string, error: unknown): void {
  console.error(
    JSON.stringify({
      capability: 'graph_mutation',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      event: 'graph_mutation_unavailable',
      operation,
      provider: 'postgres_age',
    }),
  );
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function dollarQuote(value: string): string {
  const tag = `$pufu_${createHash('sha256').update(value).digest('hex')}$`;
  return `${tag}${value}${tag}`;
}

function validateLabel(label: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(label)) {
    throw new Error(`Invalid graph label or edge type: ${label}`);
  }
  return label;
}

function validatePropertyName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid graph property name: ${name}`);
  }
  return name;
}

function parameterizedSetClause(
  variableName: string,
  properties: Record<string, unknown> | null | undefined,
): { cypher: string; params: Record<string, unknown> } {
  const assignments: string[] = [];
  const params: Record<string, unknown> = {};
  for (const [propertyName, value] of Object.entries(properties ?? {})) {
    if (value === undefined) {
      continue;
    }
    const safePropertyName = validatePropertyName(propertyName);
    assignments.push(`${variableName}.${safePropertyName} = $${safePropertyName}`);
    params[safePropertyName] = graphPropertyValue(value);
  }
  return {
    cypher: assignments.length === 0 ? '' : `SET ${assignments.join(', ')}`,
    params,
  };
}

function graphPropertyValue(value: unknown): unknown {
  return requireSafeJsonValue(value, 'graph property value');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
