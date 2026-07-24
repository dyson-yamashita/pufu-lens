import { createHash } from 'node:crypto';
import { validateGraphName } from '@pufu-lens/project-tenancy';
import type postgres from 'postgres';
import { parseSyntheticMonitorAgeCountRows } from './synthetic-monitor-age.ts';
import {
  SYNTHETIC_MONITOR_RELATION_TYPES,
  SYNTHETIC_MONITOR_STATEMENT_TIMEOUT_MS,
} from './synthetic-monitor-contract.ts';
import {
  parseSyntheticMonitorChunkCountRow,
  parseSyntheticMonitorDocumentRow,
  parseSyntheticMonitorPeriodRunRow,
  parseSyntheticMonitorProjectRow,
  parseSyntheticMonitorRawDocumentRow,
  parseSyntheticMonitorReportMetadataRow,
  parseSyntheticMonitorReportScheduleRow,
  parseSyntheticMonitorScheduleRows,
} from './synthetic-monitor-repository-rows.ts';
import type { SyntheticMonitorRepository } from './synthetic-monitor-service.ts';

/**
 * Creates a read-only PostgreSQL repository for Synthetic Monitor observations.
 *
 * @param sql - Shared postgres client.
 * @returns Repository that scopes all reads to project identifiers.
 */
export function createPostgresSyntheticMonitorRepository(
  sql: postgres.Sql,
): SyntheticMonitorRepository {
  return {
    async lookupProject(slug) {
      return withReadOnlyQuery(sql, async (tx) => {
        const rows = (await tx`
          SELECT id::text AS id, slug, graph_name AS "graphName"
          FROM public.projects
          WHERE slug = ${slug}
          LIMIT 1
        `) as readonly unknown[];
        return parseSyntheticMonitorProjectRow(rows);
      });
    },
    lookupRawDocument(input) {
      return withReadOnlyQuery(sql, async (tx) => {
        const rows = (await tx`
          SELECT
            id::text AS id,
            ingest_status AS "ingestStatus",
            source_version AS "sourceVersion"
          FROM public.raw_documents
          WHERE project_id = ${input.projectId}::uuid
            AND source_type = ${input.sourceType}
            AND logical_source_id = ${input.logicalSourceId}
            AND source_version = ${input.sourceVersion}
          LIMIT 1
        `) as readonly unknown[];
        return parseSyntheticMonitorRawDocumentRow(rows);
      });
    },
    lookupLatestRawDocument(input) {
      return withReadOnlyQuery(sql, async (tx) => {
        const rows = (await tx`
          SELECT
            id::text AS id,
            ingest_status AS "ingestStatus",
            source_version AS "sourceVersion"
          FROM public.raw_documents AS current
          WHERE current.project_id = ${input.projectId}::uuid
            AND current.source_type = ${input.sourceType}
            AND current.logical_source_id = ${input.logicalSourceId}
            AND NOT EXISTS (
              SELECT 1
              FROM public.raw_documents AS newer
              WHERE newer.project_id = current.project_id
                AND newer.source_type = current.source_type
                AND newer.logical_source_id = current.logical_source_id
                AND (
                  newer.fetched_at > current.fetched_at
                  OR (
                    newer.fetched_at = current.fetched_at
                    AND newer.id > current.id
                  )
                )
            )
          LIMIT 1
        `) as readonly unknown[];
        return parseSyntheticMonitorRawDocumentRow(rows);
      });
    },
    lookupDocument(input) {
      return withReadOnlyQuery(sql, async (tx) => {
        const rows = (await tx`
          SELECT
            id::text AS id,
            raw_document_id::text AS "rawDocumentId",
            graph_node_id AS "graphNodeId"
          FROM public.documents
          WHERE project_id = ${input.projectId}::uuid
            AND doc_type = ${input.docType}
            AND logical_source_id = ${input.logicalSourceId}
          LIMIT 1
        `) as readonly unknown[];
        return parseSyntheticMonitorDocumentRow(rows);
      });
    },
    countDocumentChunks(input) {
      return withReadOnlyQuery(sql, async (tx) => {
        const rows = (await tx`
          SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE embedding IS NOT NULL)::int AS "withEmbedding"
          FROM public.document_chunks
          WHERE project_id = ${input.projectId}::uuid
            AND document_id = ${input.documentId}::uuid
        `) as readonly unknown[];
        return parseSyntheticMonitorChunkCountRow(rows);
      });
    },
    countGraphDocumentNode(input) {
      const graphName = validateGraphName(input.graphName);
      return withReadOnlyQuery(sql, async (tx) => {
        const rows = (await tx.unsafe(
          `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(
            'MATCH (node:Document {graphNodeId: $graphNodeId}) RETURN count(node) AS nodeCount',
          )}, $1::agtype) AS (value agtype)`,
          [JSON.stringify({ graphNodeId: input.graphNodeId })],
        )) as readonly unknown[];
        return parseSyntheticMonitorAgeCountRows(rows, 'nodeCount');
      });
    },
    countGraphRelations(input) {
      const graphName = validateGraphName(input.graphName);
      return withReadOnlyQuery(sql, async (tx) => {
        const counts: Record<string, number> = {};
        for (const relationType of SYNTHETIC_MONITOR_RELATION_TYPES) {
          const rows = (await tx.unsafe(
            `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(
              [
                'MATCH (node:Document {graphNodeId: $graphNodeId})',
                `MATCH (node)-[relation:${relationType}]-()`,
                'RETURN count(relation) AS relationCount',
              ].join(' '),
            )}, $1::agtype) AS (value agtype)`,
            [JSON.stringify({ graphNodeId: input.graphNodeId })],
          )) as readonly unknown[];
          counts[relationType] = parseSyntheticMonitorAgeCountRows(rows, 'relationCount');
        }
        return counts;
      });
    },
    lookupSchedulesForLogicalSource(input) {
      return withReadOnlyQuery(sql, async (tx) => {
        const rows = (await tx`
          SELECT DISTINCT
            schedule.enabled,
            schedule.retry_count AS "retryCount",
            schedule.lease_expires_at::text AS "leaseExpiresAt",
            schedule.next_run_at::text AS "nextRunAt"
          FROM public.raw_documents AS raw
          JOIN public.raw_document_data_sources AS link
            ON link.project_id = raw.project_id
           AND link.raw_document_id = raw.id
          JOIN public.data_sources AS source
            ON source.id = link.data_source_id
           AND source.project_id = link.project_id
          JOIN public.data_source_schedules AS schedule
            ON schedule.data_source_id = source.id
           AND schedule.project_id = source.project_id
          WHERE raw.project_id = ${input.projectId}::uuid
            AND raw.source_type = ${input.sourceType}
            AND raw.logical_source_id = ${input.logicalSourceId}
        `) as readonly unknown[];
        return parseSyntheticMonitorScheduleRows(rows);
      });
    },
    lookupReportSchedule(projectId) {
      return withReadOnlyQuery(sql, async (tx) => {
        const rows = (await tx`
          SELECT frequency, next_run_at::text AS "nextRunAt"
          FROM public.project_report_schedules
          WHERE project_id = ${projectId}::uuid
          LIMIT 1
        `) as readonly unknown[];
        return parseSyntheticMonitorReportScheduleRow(rows);
      });
    },
    lookupPeriodRun(input) {
      return withReadOnlyQuery(sql, async (tx) => {
        const rows = (await tx`
          SELECT status, report_id::text AS "reportId"
          FROM public.report_schedule_period_runs
          WHERE project_id = ${input.projectId}::uuid
            AND frequency = ${input.frequency}
            AND period_start = ${input.periodStart}::date
            AND period_end = ${input.periodEnd}::date
          LIMIT 1
        `) as readonly unknown[];
        return parseSyntheticMonitorPeriodRunRow(rows);
      });
    },
    lookupReportMetadata(input) {
      return withReadOnlyQuery(sql, async (tx) => {
        const rows = (await tx`
          SELECT schema_version AS "schemaVersion", storage_uri AS "storageUri"
          FROM public.reports
          WHERE project_id = ${input.projectId}::uuid
            AND id = ${input.reportId}::uuid
          LIMIT 1
        `) as readonly unknown[];
        return parseSyntheticMonitorReportMetadataRow(rows);
      });
    },
  };
}

async function withReadOnlyQuery<T>(
  sql: postgres.Sql,
  callback: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx.unsafe(`SET LOCAL statement_timeout = '${SYNTHETIC_MONITOR_STATEMENT_TIMEOUT_MS}ms'`);
    await tx.unsafe(`LOAD 'age'`);
    await tx`SET LOCAL search_path = ag_catalog, "$user", public`;
    return callback(tx);
  }) as Promise<T>;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function dollarQuote(value: string): string {
  const tag = `$pufu_${createHash('sha256').update(value).digest('hex')}$`;
  return `${tag}${value}${tag}`;
}
