import { createHash } from 'node:crypto';
import type postgres from 'postgres';

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

export type ActorGraphReconcileResult =
  | { readonly status: 'merged'; readonly deletedCount: number }
  | { readonly reason: string; readonly status: 'skipped' };

export interface ActorGraphReconcileInput {
  readonly graphName: string | null;
  readonly primaryActorId: string;
  readonly primaryGraphNodeId: string;
  readonly secondaryGraphNodeId: string;
}

function validateGraphName(graphName: string): string {
  if (!/^graph_[a-z0-9_]+$/.test(graphName) || graphName.length > 63) {
    throw new Error(`Invalid AGE graph name: ${graphName}`);
  }
  return graphName;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function dollarQuote(value: string): string {
  const tag = `$pufu_${createHash('sha256').update(value).digest('hex')}$`;
  return `${tag}${value}${tag}`;
}

/**
 * Reconciles merged actor graph nodes inside the caller's open transaction.
 *
 * Safe no-ops return without throwing when the project graph is unset, both actors
 * share the same graph node id, or the secondary graph node is already absent even if
 * the primary node is also missing. Unsafe graph states such as a duplicate secondary
 * node, or a missing or duplicate primary node while secondary exists, reject the
 * transaction.
 *
 * @param tx - Open postgres.js transaction executing AGE cypher via LOAD 'age'.
 * @param input - Primary and secondary actor graph node ids plus the surviving actor id.
 * @throws When AGE cypher fails or the graph state is not reconcilable.
 */
export async function mergeActorGraphElements(
  tx: postgres.TransactionSql,
  input: ActorGraphReconcileInput,
): Promise<ActorGraphReconcileResult> {
  if (!input.graphName) {
    return { reason: 'project graph is not configured', status: 'skipped' };
  }
  if (input.primaryGraphNodeId === input.secondaryGraphNodeId) {
    return { reason: 'primary and secondary graph nodes are identical', status: 'skipped' };
  }

  const safeGraphName = validateGraphName(input.graphName);
  await tx`LOAD 'age'`;
  await tx`SET LOCAL search_path = ag_catalog, "$user", public`;
  const secondaryCount = await countActorGraphNode(
    tx,
    safeGraphName,
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
    tx,
    safeGraphName,
    input.primaryGraphNodeId,
    'primary actor graph node',
  );
  if (primaryCount !== 1) {
    throw new Error(`expected 1 primary actor graph node, found ${primaryCount}`);
  }

  for (const edgeType of ACTOR_EDGE_TYPES) {
    const outgoingRows = (await tx.unsafe(
      `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
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
    const incomingRows = (await tx.unsafe(
      `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
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
  const deleteRows = (await tx.unsafe(
    `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
      [
        'MATCH (secondary {graphNodeId: $secondaryGraphNodeId})',
        'WITH secondary, count(secondary) AS deletedCount',
        'DETACH DELETE secondary',
        'RETURN deletedCount',
      ].join(' '),
    )}, $1::agtype) AS (value agtype)`,
    [JSON.stringify(actorGraphParameters(input))],
  )) as readonly unknown[];
  const deletedCount = parseActorGraphCountRows(deleteRows, 'secondary actor delete count');
  if (deletedCount !== 1) {
    throw new Error(
      `Actor graph reconcile failed: expected to delete 1 secondary node, deleted ${deletedCount}.`,
    );
  }
  return { deletedCount, status: 'merged' };
}

type ActorGraphCypherParameters = {
  readonly primaryActorId: string;
  readonly primaryGraphNodeId: string;
  readonly secondaryGraphNodeId: string;
};

// graphName is interpolated into the cypher() call separately and must not be passed as agtype.
function actorGraphParameters(input: ActorGraphReconcileInput): ActorGraphCypherParameters {
  return {
    primaryActorId: input.primaryActorId,
    primaryGraphNodeId: input.primaryGraphNodeId,
    secondaryGraphNodeId: input.secondaryGraphNodeId,
  };
}

async function countActorGraphNode(
  sql: postgres.TransactionSql,
  safeGraphName: string,
  graphNodeId: string,
  label: string,
): Promise<number> {
  const rows = (await sql.unsafe(
    `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
      ['MATCH (node {graphNodeId: $graphNodeId})', 'RETURN count(node) AS nodeCount'].join(' '),
    )}, $1::agtype) AS (value agtype)`,
    [JSON.stringify({ graphNodeId })],
  )) as readonly unknown[];
  return parseActorGraphCountRows(rows, label);
}

export function parseActorGraphCountRows(rows: readonly unknown[], label: string): number {
  if (rows.length !== 1) {
    throw new Error(`Invalid AGE ${label}: expected 1 row, received ${rows.length}.`);
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error(`Invalid AGE ${label}: row is not an object.`);
  }
  return parseAgeInteger(row.value, label);
}

function parseActorGraphOptionalCountRows(rows: readonly unknown[], label: string): number {
  if (rows.length === 0) {
    return 0;
  }
  return parseActorGraphCountRows(rows, label);
}

function parseAgeInteger(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }
  throw new Error(`Invalid AGE ${label}: value is not a safe integer.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
