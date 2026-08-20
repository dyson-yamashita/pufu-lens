import type postgres from 'postgres';
import {
  type GraphRelatedDocumentCandidate,
  type GraphRelatedRelationType,
  parseGraphRelatedDocumentCandidate,
} from './index.js';
import { graphRelationQueryRowLimit, isRecord } from './postgres-relational-common.js';

export const GRAPH_PRESET_QUERY_LIMIT = 501;

/** Runs a graph read callback inside a read-only postgres.js transaction with a 5s timeout. */
export async function withReadOnlyTransaction<T>(
  sql: postgres.Sql,
  operation: (transaction: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (transaction) => {
    await transaction`SET TRANSACTION READ ONLY`;
    await transaction`SET LOCAL statement_timeout = '5000ms'`;
    return operation(transaction);
  });
  return result as T;
}

/** Static related-document SQL definitions executed with bound project and seed identifiers. */
export const RELATED_DOCUMENT_QUERIES: readonly {
  readonly hopCount: 1 | 2;
  readonly relationType: GraphRelatedRelationType;
  readonly sql: string;
}[] = [
  {
    hopCount: 1,
    relationType: 'SAME_AS',
    sql: `
      SELECT
        seed.properties ->> 'documentId' AS "seedDocumentId",
        related.properties ->> 'documentId' AS "documentId"
      FROM public.graph_nodes seed
      JOIN public.graph_edges edge
        ON edge.project_id = seed.project_id
       AND edge.relation_type = 'SAME_AS'
       AND (
         (edge.source_node_key = seed.node_key AND edge.target_node_key <> seed.node_key)
         OR (edge.target_node_key = seed.node_key AND edge.source_node_key <> seed.node_key)
       )
      JOIN public.graph_nodes related
        ON related.project_id = edge.project_id
       AND related.kind = 'document'
       AND (
         (edge.source_node_key = seed.node_key AND edge.target_node_key = related.node_key)
         OR (edge.target_node_key = seed.node_key AND edge.source_node_key = related.node_key)
       )
      WHERE seed.project_id = $1::uuid
        AND seed.kind = 'document'
        AND seed.properties ->> 'documentId' = ANY($2::text[])
        AND related.properties ->> 'documentId' <> ALL($2::text[])
      ORDER BY seed.properties ->> 'documentId', related.properties ->> 'documentId'
      LIMIT $3
    `,
  },
  {
    hopCount: 1,
    relationType: 'RELATED_TO',
    sql: `
      SELECT
        seed.properties ->> 'documentId' AS "seedDocumentId",
        related.properties ->> 'documentId' AS "documentId"
      FROM public.graph_nodes seed
      JOIN public.graph_edges edge
        ON edge.project_id = seed.project_id
       AND edge.relation_type = 'RELATED_TO'
       AND (
         edge.source_node_key = seed.node_key OR edge.target_node_key = seed.node_key
       )
      JOIN public.graph_nodes related
        ON related.project_id = edge.project_id
       AND related.kind = 'document'
       AND (
         (edge.source_node_key = seed.node_key AND edge.target_node_key = related.node_key)
         OR (edge.target_node_key = seed.node_key AND edge.source_node_key = related.node_key)
       )
      WHERE seed.project_id = $1::uuid
        AND seed.kind = 'document'
        AND seed.properties ->> 'documentId' = ANY($2::text[])
        AND related.properties ->> 'documentId' <> ALL($2::text[])
      ORDER BY seed.properties ->> 'documentId', related.properties ->> 'documentId'
      LIMIT $3
    `,
  },
  {
    hopCount: 2,
    relationType: 'MENTIONS',
    sql: `
      SELECT
        seed.properties ->> 'documentId' AS "seedDocumentId",
        related.properties ->> 'documentId' AS "documentId"
      FROM public.graph_nodes seed
      JOIN public.graph_edges edge_seed
        ON edge_seed.project_id = seed.project_id
       AND edge_seed.relation_type = 'MENTIONS'
       AND (
         edge_seed.source_node_key = seed.node_key OR edge_seed.target_node_key = seed.node_key
       )
      JOIN public.graph_nodes topic
        ON topic.project_id = edge_seed.project_id
       AND topic.kind = 'topic'
       AND (
         (edge_seed.source_node_key = seed.node_key AND edge_seed.target_node_key = topic.node_key)
         OR (edge_seed.target_node_key = seed.node_key AND edge_seed.source_node_key = topic.node_key)
       )
      JOIN public.graph_edges edge_related
        ON edge_related.project_id = topic.project_id
       AND edge_related.relation_type = 'MENTIONS'
       AND (
         edge_related.source_node_key = topic.node_key OR edge_related.target_node_key = topic.node_key
       )
      JOIN public.graph_nodes related
        ON related.project_id = edge_related.project_id
       AND related.kind = 'document'
       AND (
         (edge_related.source_node_key = topic.node_key AND edge_related.target_node_key = related.node_key)
         OR (edge_related.target_node_key = topic.node_key AND edge_related.source_node_key = related.node_key)
       )
      WHERE seed.project_id = $1::uuid
        AND seed.kind = 'document'
        AND seed.properties ->> 'documentId' = ANY($2::text[])
        AND related.properties ->> 'documentId' <> ALL($2::text[])
      ORDER BY seed.properties ->> 'documentId', related.properties ->> 'documentId'
      LIMIT $3
    `,
  },
];

/** Executes the actor-documents preset query for eligible document node keys. */
export async function queryActorDocumentsPreset(
  transaction: postgres.TransactionSql,
  projectId: string,
  documentGraphNodeIds: readonly string[],
): Promise<readonly unknown[]> {
  return transaction`
    SELECT
      source.node_key AS "sourceNodeKey",
      source.kind AS "sourceKind",
      source.properties AS "sourceProperties",
      target.node_key AS "targetNodeKey",
      target.kind AS "targetKind",
      target.properties AS "targetProperties",
      edge.source_node_key AS "edgeSource",
      edge.target_node_key AS "edgeTarget",
      edge.relation_type AS "edgeLabel",
      edge.properties AS "edgeProperties"
    FROM public.graph_edges edge
    JOIN public.graph_nodes source
      ON source.project_id = edge.project_id
     AND source.node_key = edge.source_node_key
    JOIN public.graph_nodes target
      ON target.project_id = edge.project_id
     AND target.node_key = edge.target_node_key
    WHERE edge.project_id = ${projectId}::uuid
      AND source.kind = 'actor'
      AND target.kind = 'document'
      AND target.node_key IN ${transaction(documentGraphNodeIds)}
    ORDER BY edge.source_node_key, edge.target_node_key, edge.relation_type
    LIMIT ${GRAPH_PRESET_QUERY_LIMIT}
  `;
}

/** Executes the recent-relations preset query for eligible document node keys. */
export async function queryRecentRelationsPreset(
  transaction: postgres.TransactionSql,
  projectId: string,
  documentGraphNodeIds: readonly string[],
): Promise<readonly unknown[]> {
  return transaction`
    SELECT
      doc.node_key AS "sourceNodeKey",
      doc.kind AS "sourceKind",
      doc.properties AS "sourceProperties",
      neighbor.node_key AS "targetNodeKey",
      neighbor.kind AS "targetKind",
      neighbor.properties AS "targetProperties",
      edge.source_node_key AS "edgeSource",
      edge.target_node_key AS "edgeTarget",
      edge.relation_type AS "edgeLabel",
      edge.properties AS "edgeProperties"
    FROM public.graph_nodes doc
    JOIN public.graph_edges edge
      ON edge.project_id = doc.project_id
     AND (
       edge.source_node_key = doc.node_key OR edge.target_node_key = doc.node_key
     )
    JOIN public.graph_nodes neighbor
      ON neighbor.project_id = doc.project_id
     AND (
       (edge.source_node_key = doc.node_key AND edge.target_node_key = neighbor.node_key)
       OR (edge.target_node_key = doc.node_key AND edge.source_node_key = neighbor.node_key)
     )
    WHERE doc.project_id = ${projectId}::uuid
      AND doc.kind = 'document'
      AND doc.node_key IN ${transaction(documentGraphNodeIds)}
      AND (
        neighbor.kind IN ('actor', 'topic')
        OR (
          neighbor.kind = 'document'
          AND neighbor.node_key IN ${transaction(documentGraphNodeIds)}
          AND doc.node_key <= neighbor.node_key
        )
      )
    ORDER BY doc.node_key, neighbor.node_key, edge.relation_type
    LIMIT ${GRAPH_PRESET_QUERY_LIMIT}
  `;
}

/** Selects bounded related-document candidates from raw relational query rows. */
export function selectRelatedDocumentCandidates(input: {
  readonly hopCount: 1 | 2;
  readonly limit: number;
  readonly relationType: GraphRelatedRelationType;
  readonly rows: readonly unknown[];
}): GraphRelatedDocumentCandidate[] {
  const candidates: GraphRelatedDocumentCandidate[] = [];
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (candidates.length >= input.limit) {
      break;
    }
    const parsed = parseRelatedDocumentQueryRow(row);
    if (seen.has(parsed.documentId)) {
      continue;
    }
    seen.add(parsed.documentId);
    candidates.push(
      parseGraphRelatedDocumentCandidate({
        documentId: parsed.documentId,
        hopCount: input.hopCount,
        relationType: input.relationType,
        seedDocumentId: parsed.seedDocumentId,
      }),
    );
  }
  return candidates;
}

function parseRelatedDocumentQueryRow(row: unknown): {
  readonly documentId: string;
  readonly seedDocumentId: string;
} {
  if (!isRecord(row)) {
    throw new Error('Invalid relational related document row.');
  }
  const seedDocumentId = row.seedDocumentId;
  const documentId = row.documentId;
  if (typeof seedDocumentId !== 'string' || seedDocumentId.trim().length === 0) {
    throw new Error('Invalid relational related document row: seedDocumentId.');
  }
  if (typeof documentId !== 'string' || documentId.trim().length === 0) {
    throw new Error('Invalid relational related document row: documentId.');
  }
  return { documentId, seedDocumentId };
}

export { graphRelationQueryRowLimit };
