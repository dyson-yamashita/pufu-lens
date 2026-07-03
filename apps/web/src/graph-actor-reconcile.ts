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

export async function reconcileMergedActorGraphElements(
  sql: postgres.Sql,
  input: ActorGraphReconcileInput,
): Promise<void> {
  try {
    const result = await mergeActorGraphElements(sql, input);
    if (result.status === 'skipped' && result.reason !== 'secondary actor graph node not found') {
      console.warn(`AGE actor graph reconcile skipped: ${result.reason}.`);
    }
  } catch (error) {
    console.warn(
      `AGE actor graph reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function mergeActorGraphElements(
  sql: postgres.Sql,
  input: ActorGraphReconcileInput,
): Promise<ActorGraphReconcileResult> {
  if (!input.graphName) {
    return { reason: 'project graph is not configured', status: 'skipped' };
  }
  if (input.primaryGraphNodeId === input.secondaryGraphNodeId) {
    return { reason: 'primary and secondary graph nodes are identical', status: 'skipped' };
  }

  const safeGraphName = validateGraphName(input.graphName);
  return sql.begin(async (transaction) => {
    await transaction`LOAD 'age'`;
    await transaction`SET LOCAL search_path = ag_catalog, "$user", public`;
    const primaryCount = await countActorGraphNode(
      transaction,
      safeGraphName,
      input.primaryGraphNodeId,
      'primary actor graph node',
    );
    if (primaryCount !== 1) {
      return {
        reason: `expected 1 primary actor graph node, found ${primaryCount}`,
        status: 'skipped',
      };
    }
    const secondaryCount = await countActorGraphNode(
      transaction,
      safeGraphName,
      input.secondaryGraphNodeId,
      'secondary actor graph node',
    );
    if (secondaryCount === 0) {
      return { reason: 'secondary actor graph node not found', status: 'skipped' };
    }
    if (secondaryCount !== 1) {
      return {
        reason: `expected 1 secondary actor graph node, found ${secondaryCount}`,
        status: 'skipped',
      };
    }

    for (const edgeType of ACTOR_EDGE_TYPES) {
      const outgoingRows = (await transaction.unsafe(
        `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
          [
            'MATCH (primary {graphNodeId: $primaryGraphNodeId})',
            'MATCH (secondary {graphNodeId: $secondaryGraphNodeId})',
            `MATCH (secondary)-[relation:${edgeType}]->(target)`,
            'WHERE target.graphNodeId IS NULL OR target.graphNodeId <> $primaryGraphNodeId',
            `MERGE (primary)-[merged:${edgeType}]->(target)`,
            'SET merged += properties(relation)',
            'RETURN count(merged) AS mergedCount',
          ].join(' '),
        )}, $1::agtype) AS (value agtype)`,
        [JSON.stringify(input)],
      )) as readonly unknown[];
      parseActorGraphCountRows(outgoingRows, `${edgeType} outgoing merge count`);
      const incomingRows = (await transaction.unsafe(
        `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
          [
            'MATCH (primary {graphNodeId: $primaryGraphNodeId})',
            'MATCH (secondary {graphNodeId: $secondaryGraphNodeId})',
            `MATCH (source)-[relation:${edgeType}]->(secondary)`,
            'WHERE source.graphNodeId IS NULL OR source.graphNodeId <> $primaryGraphNodeId',
            `MERGE (source)-[merged:${edgeType}]->(primary)`,
            'SET merged += properties(relation)',
            'RETURN count(merged) AS mergedCount',
          ].join(' '),
        )}, $1::agtype) AS (value agtype)`,
        [JSON.stringify(input)],
      )) as readonly unknown[];
      parseActorGraphCountRows(incomingRows, `${edgeType} incoming merge count`);
    }
    const deleteRows = (await transaction.unsafe(
      `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
        [
          'MATCH (secondary {graphNodeId: $secondaryGraphNodeId})',
          'DETACH DELETE secondary',
          'RETURN count(secondary) AS deletedCount',
        ].join(' '),
      )}, $1::agtype) AS (value agtype)`,
      [JSON.stringify(input)],
    )) as readonly unknown[];
    const deletedCount = parseActorGraphCountRows(deleteRows, 'secondary actor delete count');
    if (deletedCount !== 1) {
      throw new Error(
        `Actor graph reconcile failed: expected to delete 1 secondary node, deleted ${deletedCount}.`,
      );
    }
    return { deletedCount, status: 'merged' };
  });
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
