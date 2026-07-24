import type postgres from 'postgres';
import type { SourceType } from '../../packages/ingestion/dist/index.js';
import { builtInParserProfileName } from '../../packages/ingestion/dist/index.js';
import {
  parseFirstSqlRow,
  parseReprocessCandidateRows,
  parseReprocessResetSummaryRow,
  parseStaleParserCountRow,
} from './ingest-workflow-reprocess-row-parsers.ts';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

/** Source types that `ingest:reprocess` can reset for parser-version migration. */
export const REPROCESS_SUPPORTED_SOURCE_TYPES = ['github'] as const;

/** Supported `--source` value for `ingest:reprocess`. */
export type ReprocessSupportedSourceType = (typeof REPROCESS_SUPPORTED_SOURCE_TYPES)[number];

/**
 * Project and source scope resolved from `ingest:reprocess` CLI options.
 */
export type ReprocessScope = {
  dataSourceId?: string;
  projectSlug: string;
  sourceType: ReprocessSupportedSourceType;
};

/**
 * One queue-bound raw document selected for parser-version reprocess.
 */
export type ReprocessCandidate = {
  queueId: string;
  rawDocumentId: string;
  sourceId: string;
};

/**
 * Result of applying a bounded parser-version reprocess reset batch.
 */
export type ReprocessResetResult = {
  queueItems: number;
  rawDocuments: number;
  remaining: number;
  selected: ReprocessCandidate[];
};

/**
 * Validates `ingest:reprocess` CLI options and returns the resolved project scope.
 *
 * @param input - Parsed CLI flags. Either `--apply` or `--dry-run` must be set.
 * @returns Resolved project slug and supported source type.
 * @throws When required flags are missing or the source type is unsupported.
 */
export function validateReprocessCommandOptions(input: {
  apply?: boolean;
  dryRun?: boolean;
  project?: string;
  source?: SourceType;
}): ReprocessScope {
  const projectSlug = input.project?.trim();
  if (!projectSlug) {
    throw new Error('--project is required for ingest:reprocess.');
  }
  if (!input.source) {
    throw new Error('--source is required for ingest:reprocess.');
  }
  if (!(REPROCESS_SUPPORTED_SOURCE_TYPES as readonly string[]).includes(input.source)) {
    throw new Error(
      `ingest:reprocess currently supports --source ${REPROCESS_SUPPORTED_SOURCE_TYPES.join('|')} only.`,
    );
  }
  if (!input.apply && !input.dryRun) {
    throw new Error('ingest:reprocess requires --apply or --dry-run.');
  }
  return { projectSlug, sourceType: input.source as ReprocessSupportedSourceType };
}

/**
 * Counts queue-bound raw documents whose stored parser version differs from the active version.
 *
 * @param input - Project scope and optional data source filter.
 * @returns Number of remaining reprocess candidates.
 */
export async function countStaleParserRawDocuments(input: {
  dataSourceId?: string;
  projectId: string;
  sourceType: ReprocessSupportedSourceType;
  sql: SqlExecutor;
}): Promise<number> {
  const rows = await input.sql`
    SELECT count(*)::int AS count
    FROM (${staleParserRawDocumentsQuery(input)}) candidates
  `;
  return parseStaleParserCountRow(parseFirstSqlRow(rows, 'stale parser count')).count;
}

/**
 * Lists the next bounded batch of queue-bound stale parser raw documents without mutating state.
 *
 * @param input - Project scope, optional data source filter, and maximum rows to return.
 * @returns Candidates ordered by raw `updated_at` then queue id.
 */
export async function listStaleParserRawDocuments(input: {
  dataSourceId?: string;
  limit: number;
  projectId: string;
  sourceType: ReprocessSupportedSourceType;
  sql: SqlExecutor;
}): Promise<ReprocessCandidate[]> {
  const rows = await input.sql`
    SELECT
      candidates.raw_document_id::text AS "rawDocumentId",
      candidates.queue_id::text AS "queueId",
      candidates.source_id AS "sourceId"
    FROM (${staleParserRawDocumentsQuery(input)}) candidates
    ORDER BY candidates.updated_at ASC, candidates.queue_id ASC
    LIMIT ${input.limit}
  `;
  return parseReprocessCandidateRows(rows);
}

/**
 * Resets a bounded batch of stale parser queue items and their raw documents in one transaction.
 *
 * Candidate selection and updates run atomically with `FOR UPDATE OF q SKIP LOCKED` so concurrent
 * workers cannot claim the same queue row. Parsed URI is cleared so a later parse failure cannot
 * be retried back to the previous parsed JSON.
 *
 * @param input - Project scope, optional data source filter, and maximum rows to reset.
 * @returns Reset counts, remaining candidates, and selected `ReprocessCandidate` values
 *   (`queueId`, `rawDocumentId`, `sourceId`).
 */
export async function resetStaleParserRawDocuments(input: {
  dataSourceId?: string;
  limit: number;
  projectId: string;
  sourceType: ReprocessSupportedSourceType;
  sql: postgres.Sql;
}): Promise<ReprocessResetResult> {
  return input.sql.begin(async (transaction: postgres.TransactionSql) => {
    const rows = await transaction`
      WITH candidates AS (
        ${staleParserRawDocumentsQuery({ ...input, sql: transaction })}
        ORDER BY rd.updated_at ASC, q.id ASC
        LIMIT ${input.limit}
        FOR UPDATE OF q SKIP LOCKED
      ),
      updated_raw AS (
        UPDATE public.raw_documents rd
        SET
          ingest_status = 'fetched',
          ingest_error = null,
          hold_reason = null,
          parsed_at = null,
          parsed_uri = null,
          parser_profile_id = null,
          parser_version_id = null,
          parser_artifact_hash = null,
          parsed_schema_version = null
        FROM candidates c
        WHERE rd.id = c.raw_document_id
          AND rd.project_id = ${input.projectId}
        RETURNING rd.id
      ),
      updated_queue AS (
        UPDATE public.ingestion_queue q
        SET
          status = 'pending',
          last_error = null,
          hold_reason = null,
          lease_expires_at = null,
          parser_profile_id = null,
          parser_version_id = null,
          scheduled_at = now()
        FROM candidates c
        WHERE q.id = c.queue_id
          AND q.project_id = ${input.projectId}
        RETURNING q.id
      )
      SELECT
        (SELECT count(*)::int FROM updated_raw) AS "rawDocuments",
        (SELECT count(*)::int FROM updated_queue) AS "queueItems",
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'queueId', c.queue_id::text,
                'rawDocumentId', c.raw_document_id::text,
                'sourceId', c.source_id
              )
              ORDER BY c.queue_id
            )
            FROM candidates c
          ),
          '[]'::json
        ) AS selected
    `;

    const result = parseReprocessResetSummaryRow(parseFirstSqlRow(rows, 'reprocess reset summary'));
    const remaining = await countStaleParserRawDocuments({
      ...input,
      sql: transaction,
    });

    return {
      queueItems: result.queueItems,
      rawDocuments: result.rawDocuments,
      remaining,
      selected: result.selected,
    };
  });
}

function staleParserRawDocumentsQuery(input: {
  dataSourceId?: string;
  projectId: string;
  sourceType: ReprocessSupportedSourceType;
  sql: SqlExecutor;
}) {
  const builtInProfileName = builtInParserProfileName(input.sourceType);
  return input.sql`
    SELECT
      q.id AS queue_id,
      rd.id AS raw_document_id,
      rd.source_id,
      rd.updated_at
    FROM public.ingestion_queue q
    JOIN public.raw_documents rd
      ON rd.id = q.raw_document_id
     AND rd.project_id = q.project_id
    JOIN public.data_sources ds
      ON ds.id = q.data_source_id
     AND ds.project_id = q.project_id
    JOIN public.parser_profiles pp
      ON pp.data_source_id = ds.id
     AND pp.project_id = q.project_id
     AND pp.source_type = ds.source_type
     AND pp.name = ${builtInProfileName}
    WHERE q.project_id = ${input.projectId}
      AND rd.source_type = ${input.sourceType}
      AND ds.source_type = ${input.sourceType}
      AND ds.enabled = true
      AND pp.active_version_id IS NOT NULL
      AND rd.ingest_status IN ('parsed', 'indexed')
      AND rd.parser_version_id IS DISTINCT FROM pp.active_version_id
      AND (${input.dataSourceId ?? null}::uuid IS NULL OR q.data_source_id = ${input.dataSourceId ?? null}::uuid)
      AND NOT EXISTS (
        SELECT 1
        FROM public.raw_documents newer
        WHERE newer.project_id = rd.project_id
          AND newer.source_type = rd.source_type
          AND newer.logical_source_id = rd.logical_source_id
          AND newer.ingest_status IN ('parsed', 'indexed')
          AND (newer.created_at, newer.id) > (rd.created_at, rd.id)
      )
  `;
}
