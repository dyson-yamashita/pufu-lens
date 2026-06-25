import { createHash } from 'node:crypto';
import type postgres from 'postgres';

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

export async function deleteExclusiveDocumentGraphNodes(
  sql: postgres.Sql,
  input: { graphName: string | null; graphNodeIds: readonly string[] },
): Promise<void> {
  if (!input.graphName || input.graphNodeIds.length === 0) {
    return;
  }

  try {
    const safeGraphName = validateGraphName(input.graphName);
    await sql.begin(async (transaction) => {
      await transaction`LOAD 'age'`;
      await transaction`SET LOCAL search_path = ag_catalog, "$user", public`;
      await transaction.unsafe(
        `SELECT * FROM cypher(${sqlString(safeGraphName)}, ${dollarQuote(
          'MATCH (n:Document) WHERE n.graphNodeId IN $graphNodeIds WITH collect(n) AS nodes UNWIND nodes AS node DETACH DELETE node RETURN size(nodes) AS deletedCount',
        )}, $1::agtype) AS (value agtype)`,
        [JSON.stringify({ graphNodeIds: input.graphNodeIds })],
      );
    });
  } catch (error) {
    console.warn(
      `AGE graph cleanup skipped for ${input.graphNodeIds.length} document node(s): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
