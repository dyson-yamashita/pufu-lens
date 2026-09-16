import type postgres from 'postgres';

/** Reads bounded, project-scoped indexing presence without consulting stale AGE data. */
export async function listRelationalDocumentNodeIds(
  sql: postgres.Sql | postgres.TransactionSql,
  projectId: string,
  graphNodeIds: readonly string[],
): Promise<Set<string>> {
  if (graphNodeIds.length === 0) return new Set();
  const rows: readonly unknown[] = await sql`
    SELECT node_key FROM public.graph_nodes
    WHERE project_id = ${projectId}::uuid AND kind = 'document'
      AND node_key IN ${sql(graphNodeIds)}
  `;
  return new Set(
    rows.map((row) => {
      if (!isRecord(row) || typeof row.node_key !== 'string') {
        throw new Error('Invalid relational document graph node row.');
      }
      return row.node_key;
    }),
  );
}

/** Reads only scoped RELATED_TO edges needed by the current bounded indexing page. */
export async function listRelationalRelatedEdgeKeys(
  sql: postgres.Sql | postgres.TransactionSql,
  projectId: string,
  pairs: ReadonlyArray<{ fromGraphNodeId: string; toGraphNodeId: string }>,
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const rows: readonly unknown[] = await sql`
    SELECT source_node_key, target_node_key FROM public.graph_edges
    WHERE project_id = ${projectId}::uuid AND relation_type = 'RELATED_TO'
      AND source_node_key IN ${sql([...new Set(pairs.map((pair) => pair.fromGraphNodeId))])}
      AND target_node_key IN ${sql([...new Set(pairs.map((pair) => pair.toGraphNodeId))])}
  `;
  return new Set(
    rows.map((row) => {
      if (
        !isRecord(row) ||
        typeof row.source_node_key !== 'string' ||
        typeof row.target_node_key !== 'string'
      ) {
        throw new Error('Invalid relational related document edge row.');
      }
      return `${row.source_node_key}\u001f${row.target_node_key}`;
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
