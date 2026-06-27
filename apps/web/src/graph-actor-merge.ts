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

export async function mergeActorGraphElements(
  sql: postgres.Sql,
  input: {
    readonly graphName: string | null;
    readonly primaryGraphNodeId: string;
    readonly secondaryGraphNodeId: string;
  },
): Promise<void> {
  if (!input.graphName || input.primaryGraphNodeId === input.secondaryGraphNodeId) {
    return;
  }

  try {
    const safeGraphName = validateGraphName(input.graphName);
    await sql.begin(async (transaction) => {
      await transaction`LOAD 'age'`;
      await transaction`SET LOCAL search_path = ag_catalog, "$user", public`;
      for (const edgeType of ACTOR_EDGE_TYPES) {
        await transaction.unsafe(
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
        );
        await transaction.unsafe(
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
        );
      }
      await transaction.unsafe(
        `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
          [
            'MATCH (primary {graphNodeId: $primaryGraphNodeId})',
            'MATCH (secondary {graphNodeId: $secondaryGraphNodeId})',
            'DETACH DELETE secondary',
            'RETURN primary',
          ].join(' '),
        )}, $1::agtype) AS (value agtype)`,
        [JSON.stringify(input)],
      );
    });
  } catch (error) {
    console.warn(
      `AGE actor graph merge skipped for ${input.secondaryGraphNodeId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
