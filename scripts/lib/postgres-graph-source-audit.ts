import type { GraphSourceAuditSummary } from './graph-migration-audit.ts';
import type { PostgresGraphExecutor } from './postgres-graph-indexing-adapter.ts';

/** Audits source-of-truth blockers for graph migration compare without returning identities. */
export async function auditGraphSourceOfTruth(
  sql: PostgresGraphExecutor,
  projectId: string,
): Promise<GraphSourceAuditSummary> {
  const rows = (await sql`
    SELECT
      (
        SELECT count(*)::int
        FROM public.documents d
        JOIN public.raw_documents rd ON rd.id = d.raw_document_id
        WHERE d.project_id = ${projectId}::uuid
          AND rd.project_id = ${projectId}::uuid
          AND (
            rd.parsed_uri IS NULL
            OR rd.ingest_status NOT IN ('parsed', 'indexed')
          )
      ) AS "currentDocumentMissingParsedOrStatus",
      (
        SELECT count(*)::int
        FROM public.documents d
        JOIN public.raw_documents rd ON rd.id = d.raw_document_id
        WHERE d.project_id = ${projectId}::uuid
          AND EXISTS (
            SELECT 1
            FROM public.raw_document_data_sources rdds
            WHERE rdds.raw_document_id = rd.id
              AND rdds.metadata @> '{"lifecycleOnly": true}'::jsonb
          )
      ) AS "currentLifecycleOnlyDocument",
      (
        SELECT count(*)::int
        FROM public.actors a
        WHERE a.project_id = ${projectId}::uuid
          AND a.merged_into_actor_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.actor_merge_decisions amd
            WHERE amd.project_id = a.project_id
              AND amd.secondary_actor_id = a.id
              AND amd.decision_type = 'merge'
              AND amd.primary_actor_id = a.merged_into_actor_id
          )
      ) AS "mergedActorMissingMergeDecision",
      (
        SELECT count(*)::int
        FROM public.actor_aliases aa
        JOIN public.actors a ON a.id = aa.actor_id
        WHERE aa.project_id = ${projectId}::uuid
          AND a.merged_into_actor_id IS NOT NULL
      ) AS "mergedActorAliasReference",
      (
        SELECT count(*)::int
        FROM public.email_quotes eq
        JOIN public.actors a ON a.id = eq.sender_actor_id
        WHERE eq.project_id = ${projectId}::uuid
          AND a.merged_into_actor_id IS NOT NULL
      ) AS "mergedActorEmailQuoteReference",
      (
        SELECT count(*)::int
        FROM public.graph_nodes gn
        WHERE gn.project_id = ${projectId}::uuid
          AND gn.kind = 'document'
          AND NOT EXISTS (
            SELECT 1
            FROM public.documents d
            WHERE d.project_id = gn.project_id
              AND d.graph_node_id = gn.node_key
          )
      ) AS "relationalDocumentNodeWithoutDocumentRow"
  `) as readonly unknown[];
  return parseSourceAuditSummaryRow(rows[0]);
}

function parseSourceAuditSummaryRow(row: unknown): GraphSourceAuditSummary {
  if (!isRecord(row)) {
    throw new Error('Invalid source audit summary row.');
  }
  return {
    currentDocumentMissingParsedOrStatus: parseCountField(
      row.currentDocumentMissingParsedOrStatus,
      'currentDocumentMissingParsedOrStatus',
    ),
    currentLifecycleOnlyDocument: parseCountField(
      row.currentLifecycleOnlyDocument,
      'currentLifecycleOnlyDocument',
    ),
    mergedActorAliasReference: parseCountField(
      row.mergedActorAliasReference,
      'mergedActorAliasReference',
    ),
    mergedActorEmailQuoteReference: parseCountField(
      row.mergedActorEmailQuoteReference,
      'mergedActorEmailQuoteReference',
    ),
    mergedActorMissingMergeDecision: parseCountField(
      row.mergedActorMissingMergeDecision,
      'mergedActorMissingMergeDecision',
    ),
    relationalDocumentNodeWithoutDocumentRow: parseCountField(
      row.relationalDocumentNodeWithoutDocumentRow,
      'relationalDocumentNodeWithoutDocumentRow',
    ),
  };
}

function parseCountField(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error(`Invalid source audit field: ${fieldName}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
