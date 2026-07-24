import type postgres from 'postgres';
import type { GitHubDocumentLifecycle } from '../../packages/ingestion/dist/index.js';
import {
  buildGitHubLifecycleRefreshRaw,
  type GitHubLifecycleReconcileRepository,
  type GitHubLifecycleTarget,
} from '../../packages/ingestion/dist/index.js';
import type { ObjectStorage } from '../../packages/storage/dist/object-storage.js';
import { parseGitHubLifecycleTargetRows } from './github-lifecycle-row-parsers.ts';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

/**
 * Postgres repository for GitHub lifecycle reconciliation and backfill scripts.
 */
export class PostgresGitHubLifecycleRepository implements GitHubLifecycleReconcileRepository {
  private sql: SqlExecutor;
  private storage: ObjectStorage | undefined;

  constructor(sql: SqlExecutor, options: { storage?: ObjectStorage } = {}) {
    this.sql = sql;
    this.storage = options.storage;
  }

  async countOpenGitHubLifecycleTargets(input: {
    dataSourceId?: string;
    projectId: string;
    resumeAfterLogicalSourceId?: string;
  }): Promise<number> {
    const rows = await this.sql`
      SELECT count(*)::int AS count
      FROM (${this.targetQuery(input)}) targets
    `;
    return parseCountRow(rows);
  }

  async listOpenGitHubLifecycleTargets(input: {
    dataSourceId?: string;
    limit: number;
    projectId: string;
    resumeAfterLogicalSourceId?: string;
  }): Promise<GitHubLifecycleTarget[]> {
    const rows = await this.sql`
      SELECT *
      FROM (${this.targetQuery(input)}) targets
      ORDER BY targets."logicalSourceId" ASC
      LIMIT ${input.limit}
    `;
    const targets = parseGitHubLifecycleTargetRows(rows);
    if (!this.storage) {
      return targets;
    }
    return Promise.all(
      targets.map(async (target) => ({
        ...target,
        rawBody: (await this.storage?.getText(target.storageUri)) ?? '',
      })),
    );
  }

  async queueLifecycleRefresh(input: {
    dataSourceId: string;
    logicalSourceId: string;
    nextLifecycle: GitHubDocumentLifecycle;
    projectId: string;
    projectSlug: string;
    rawBody: string;
    rawDocumentId: string;
    rawMetadata: Record<string, unknown>;
    repository: string;
    sourceUri: string;
  }): Promise<{ queued: boolean; rawDocumentId: string }> {
    const existingRaw = JSON.parse(input.rawBody) as Record<string, unknown>;
    const refreshed = buildGitHubLifecycleRefreshRaw({
      existingMetadata: input.rawMetadata,
      existingRaw,
      nextLifecycle: input.nextLifecycle,
      repository: input.repository,
    });
    const storageUri = `${input.projectSlug}/raw/github/${safeStorageSegment(
      `${input.logicalSourceId}:${refreshed.sourceVersion}`,
    )}.json`;
    if (!this.storage) {
      throw new Error('queueLifecycleRefresh requires object storage.');
    }
    await this.storage.put(storageUri, refreshed.body, {
      contentType: 'application/json',
    });
    if (!('begin' in this.sql)) {
      throw new Error('queueLifecycleRefresh requires a postgres.Sql connection.');
    }
    return this.sql.begin(async (transaction) => {
      const inserted = await transaction`
        INSERT INTO public.raw_documents (
          project_id,
          source_type,
          source_id,
          logical_source_id,
          source_version,
          source_uri,
          storage_uri,
          mime_type,
          byte_size,
          content_hash,
          ingest_status,
          metadata
        )
        VALUES (
          ${input.projectId},
          'github',
          ${`${input.logicalSourceId}:${refreshed.sourceVersion}`},
          ${refreshed.logicalSourceId},
          ${refreshed.sourceVersion},
          ${input.sourceUri},
          ${storageUri},
          'application/json',
          ${Buffer.byteLength(refreshed.body)},
          ${refreshed.contentHash},
          'fetched',
          ${transaction.json(refreshed.metadata as postgres.JSONValue)}
        )
        ON CONFLICT (project_id, source_type, logical_source_id, source_version)
        DO NOTHING
        RETURNING id::text AS id
      `;
      const rawDocumentId = parseOptionalIdRow(inserted);
      if (!rawDocumentId) {
        return { queued: false, rawDocumentId: input.rawDocumentId };
      }
      await transaction`
        INSERT INTO public.raw_document_data_sources (
          raw_document_id,
          data_source_id,
          project_id,
          match_reason,
          metadata
        )
        VALUES (
          ${rawDocumentId},
          ${input.dataSourceId},
          ${input.projectId},
          'lifecycle_refresh',
          ${transaction.json({ lifecycleOnly: true })}
        )
        ON CONFLICT (raw_document_id, data_source_id)
        DO UPDATE SET
          last_seen_at = now(),
          match_reason = EXCLUDED.match_reason,
          metadata = EXCLUDED.metadata
      `;
      await transaction`
        INSERT INTO public.ingestion_queue (
          project_id,
          data_source_id,
          raw_document_id,
          target_id,
          status,
          scheduled_at
        )
        VALUES (
          ${input.projectId},
          ${input.dataSourceId},
          ${rawDocumentId},
          ${input.logicalSourceId},
          'pending',
          now()
        )
      `;
      return { queued: true, rawDocumentId };
    });
  }

  private targetQuery(input: {
    dataSourceId?: string;
    projectId: string;
    resumeAfterLogicalSourceId?: string;
  }) {
    return this.sql`
      SELECT
        ds.connection_id::text AS "connectionId",
        ds.id::text AS "dataSourceId",
        COALESCE(rd.metadata->'githubLifecycle'->>'kind', rd.metadata->>'kind', 'issue') AS kind,
        COALESCE(rd.metadata->'githubLifecycle'->>'state', 'open') AS "lifecycleState",
        rd.metadata AS metadata,
        rd.logical_source_id AS "logicalSourceId",
        COALESCE((rd.metadata->>'number')::int, 0) AS number,
        p.id::text AS "projectId",
        p.slug AS "projectSlug",
        rd.id::text AS "rawDocumentId",
        COALESCE(rd.metadata->>'repository', '') AS repository,
        rd.source_uri AS "sourceUri",
        rd.source_version AS "sourceVersion",
        rd.storage_uri AS "storageUri"
      FROM public.raw_documents rd
      JOIN public.projects p ON p.id = rd.project_id
      JOIN public.raw_document_data_sources rdds
        ON rdds.raw_document_id = rd.id
       AND rdds.project_id = rd.project_id
      JOIN public.data_sources ds
        ON ds.id = rdds.data_source_id
       AND ds.project_id = rd.project_id
      WHERE rd.project_id = ${input.projectId}
        AND rd.source_type = 'github'
        AND rd.ingest_status IN ('parsed', 'indexed')
        AND (${input.dataSourceId ?? null}::uuid IS NULL OR ds.id = ${input.dataSourceId ?? null}::uuid)
        AND (${input.resumeAfterLogicalSourceId ?? null}::text IS NULL OR rd.logical_source_id > ${input.resumeAfterLogicalSourceId ?? null})
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
}

function parseCountRow(rows: unknown): number {
  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }
  const row = rows[0];
  if (typeof row !== 'object' || row === null || !('count' in row)) {
    throw new Error('Invalid lifecycle count row.');
  }
  const count = (row as { count: unknown }).count;
  if (typeof count !== 'number') {
    throw new Error('Invalid lifecycle count value.');
  }
  return count;
}

function parseOptionalIdRow(rows: unknown): string | undefined {
  if (!Array.isArray(rows) || rows.length === 0) {
    return undefined;
  }
  const row = rows[0];
  if (typeof row !== 'object' || row === null || typeof (row as { id?: unknown }).id !== 'string') {
    throw new Error('Invalid raw document id row.');
  }
  return (row as { id: string }).id;
}

function safeStorageSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 120);
}
