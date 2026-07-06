'use server';

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import {
  BUILT_IN_PARSER_ARTIFACT_HASH,
  type CollectionRepository,
  collectDriveSource,
  collectGitHubSource,
  collectGmailSource,
  collectWebUrlSource,
  type DataSourceRecord,
  defaultParserContract,
  type LinkDataSourceInput,
  PARSED_SCHEMA_VERSION,
  type ProjectRecord,
  type QueueCandidateInput,
  type RawDocumentInput,
  type RawDocumentRecord,
} from '../../../packages/ingestion/dist/index.js';
import { createObjectStorageFromEnv } from '../../../packages/storage/src/factory.ts';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import {
  type AdminActionConnectionOwnerRow,
  type AdminActionDataSourceIngestRow,
  type AdminActionDataSourceRow,
  type AdminActionIdRow,
  parseAdminActionConnectionOwnerRow,
  parseAdminActionDataSourceIngestRow,
  parseAdminActionDataSourceRecordRow,
  parseAdminActionDataSourceRow,
  parseAdminActionDocumentGraphNodeRow,
  parseAdminActionIdRow,
  parseAdminActionProjectGraphNameRow,
  parseAdminActionProjectRecordRow,
  parseAdminActionRawDocumentRecordRow,
  parseAdminActionSameHashCandidateRow,
  parseAdminActionStorageObjectUriRow,
} from './admin-actions-guards.ts';
import {
  requireAdminProject,
  requireFormValue,
  revalidateProject,
  withSql,
} from './admin-actions-shared.ts';
import {
  isAdminUiCollectionSupported,
  isAdminUiIngestSupported,
  isSourceType,
  requiredProviderForSourceType,
  type SourceType,
} from './admin-data';
import { deleteExclusiveDocumentGraphNodes } from './graph-document-cleanup.ts';
import {
  createGitHubInstallationAccessToken,
  readProjectConnectionAccessToken,
} from './project-connections';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;
type CloudRunJobRunResponse = {
  readonly name?: string;
};

const DEFAULT_ADMIN_INGEST_DRAIN_MAX_BATCHES = 100;
const DEFAULT_ADMIN_INGEST_DRAIN_MAX_RUNTIME_SECONDS = 540;

function parseOptionalAdminActionIdRow(
  rows: readonly unknown[],
  context: string,
): AdminActionIdRow | undefined {
  return parseOptionalAdminActionRow(rows, (row) => parseAdminActionIdRow(row, context));
}

function parseOptionalAdminActionRow<T>(
  rows: readonly unknown[],
  parser: (row: unknown) => T,
): T | undefined {
  return rows[0] ? parser(rows[0]) : undefined;
}

function parseAdminActionRows<T>(rows: readonly unknown[], parser: (row: unknown) => T): T[] {
  return rows.map((row) => parser(row));
}

async function assertDataSourceConnectionReady(
  sql: SqlExecutor,
  projectId: string,
  sourceType: SourceType,
  connectionId?: string | null,
): Promise<AdminActionConnectionOwnerRow | undefined> {
  const connection = await lookupReadyDataSourceConnection(
    sql,
    projectId,
    sourceType,
    connectionId,
  );
  if (!connection && requiredProviderForSourceType(sourceType)) {
    throw new Error(dataSourceConnectionRequiredMessage(sourceType));
  }
  return connection;
}

function dataSourceConnectionRequiredMessage(sourceType: SourceType): string {
  return `Project connection is required before using a ${sourceType} data source. Connect or reconnect the provider in Settings.`;
}

async function lookupReadyDataSourceConnection(
  sql: SqlExecutor,
  projectId: string,
  sourceType: SourceType,
  connectionId?: string | null,
): Promise<AdminActionConnectionOwnerRow | undefined> {
  const provider = requiredProviderForSourceType(sourceType);
  if (!provider) {
    return undefined;
  }
  if (connectionId === null) {
    return undefined;
  }
  const sourceScope = requiredScopeForSourceType(sourceType);
  const scopeFilter = sourceScope ? sql`${sourceScope} = ANY(oc.scopes)` : sql`true`;
  const githubFilter = provider === 'github' ? sql`AND oc.metadata ? 'installationId'` : sql``;
  const connectionFilter = connectionId ? sql`AND oc.id = ${connectionId}` : sql``;
  const rows = (await sql`
    SELECT oc.id::text AS id, oc.user_id::text AS "userId"
    FROM public.oauth_connections oc
    WHERE oc.project_id = ${projectId}
      AND oc.provider = ${provider}
      ${connectionFilter}
      AND (oc.expires_at IS NULL OR oc.expires_at > now())
      AND (oc.metadata->>'connectionError') IS DISTINCT FROM 'true'
      AND (oc.metadata->>'scopeMissing') IS DISTINCT FROM 'true'
      AND COALESCE(oc.metadata->>'status', 'connected') = 'connected'
      AND ${scopeFilter}
      ${githubFilter}
    ORDER BY oc.updated_at DESC
    LIMIT 1
  `) as readonly unknown[];
  return parseOptionalAdminActionRow(rows, parseAdminActionConnectionOwnerRow);
}

function requiredScopeForSourceType(sourceType: SourceType): string | null {
  if (sourceType === 'gmail') {
    return 'https://www.googleapis.com/auth/gmail.readonly';
  }
  if (sourceType === 'drive') {
    return 'https://www.googleapis.com/auth/drive.readonly';
  }
  return null;
}

async function insertCreatedDataSourceRow(
  sql: SqlExecutor,
  {
    connectionId,
    config,
    name,
    ownerUserId,
    projectId,
    sourceType,
  }: {
    readonly connectionId: string | null;
    readonly config: Record<string, unknown>;
    readonly name: string;
    readonly ownerUserId: string;
    readonly projectId: string;
    readonly sourceType: SourceType;
  },
): Promise<AdminActionIdRow | undefined> {
  const rows = (await sql`
    INSERT INTO public.data_sources (
      project_id,
      owner_user_id,
      connection_id,
      source_type,
      name,
      config
    )
    VALUES (
      ${projectId},
      ${ownerUserId},
      ${connectionId},
      ${sourceType},
      ${name},
      ${sql.json(config as postgres.JSONValue)}
    )
    RETURNING id::text
  `) as readonly unknown[];
  return parseOptionalAdminActionIdRow(rows, 'data source creation row');
}

export async function createDataSource(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const name = requireFormValue(formData, 'name').trim();
  if (!name) {
    throw new Error('name is required.');
  }
  const sourceType = requireSourceType(requireFormValue(formData, 'sourceType'));
  const scope = requireFormValue(formData, 'scope').trim();
  if (!scope) {
    throw new Error('scope is required.');
  }
  const config = buildDataSourceConfig(sourceType, scope);
  let createdDataSourceId: string | undefined;

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    const connection = await assertDataSourceConnectionReady(sql, project.id, sourceType);
    await sql.begin(async (tx) => {
      const dataSource = await insertCreatedDataSourceRow(tx, {
        connectionId: connection?.id ?? null,
        config,
        name,
        ownerUserId: connection?.userId ?? project.adminUserId,
        projectId: project.id,
        sourceType,
      });
      if (!dataSource) {
        throw new Error('Data source creation failed.');
      }
      createdDataSourceId = dataSource.id;
      await ensureDefaultParserProfile(tx, {
        approvedByUserId: project.adminUserId,
        dataSourceId: dataSource.id,
        projectId: project.id,
        sourceType,
      });
    });
  });

  try {
    if (createdDataSourceId) {
      try {
        await runCollectAndIngestDataSource(projectSlug, createdDataSourceId);
      } catch (error) {
        console.warn(
          `Initial collect and ingest failed after creating data source ${createdDataSourceId} in project ${projectSlug}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } finally {
    revalidateProject(projectSlug);
  }
}

export async function updateDataSource(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const dataSourceId = requireFormValue(formData, 'dataSourceId');
  const name = requireFormValue(formData, 'name').trim();
  if (!name) {
    throw new Error('name is required.');
  }
  const scope = requireFormValue(formData, 'scope').trim();
  if (!scope) {
    throw new Error('scope is required.');
  }

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    const dataSource = await lookupProjectDataSource(sql, project.id, dataSourceId);
    const connection = await lookupReadyDataSourceConnection(
      sql,
      project.id,
      dataSource.source_type,
    );
    const connectionAssignment = connection
      ? sql`,
          owner_user_id = ${connection.userId},
          connection_id = ${connection.id}`
      : requiredProviderForSourceType(dataSource.source_type)
        ? sql``
        : sql`,
          owner_user_id = ${project.adminUserId},
          connection_id = ${null}`;
    const config = buildDataSourceConfig(dataSource.source_type, scope);
    await sql`
      UPDATE public.data_sources
      SET name = ${name},
          config = ${sql.json(config as postgres.JSONValue)},
          updated_at = now()
          ${connectionAssignment}
      WHERE id = ${dataSource.id}
        AND project_id = ${project.id}
    `;
  });

  revalidateProject(projectSlug);
}

export async function deleteDataSource(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const dataSourceId = requireFormValue(formData, 'dataSourceId');

  let graphCleanup: { graphName: string | null; graphNodeIds: readonly string[] } = {
    graphName: null,
    graphNodeIds: [],
  };
  let storageObjectUris: readonly string[] = [];

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await lookupProjectDataSourceForDeletion(sql, project.id, dataSourceId);

    const graphNameRows = (await sql`
      SELECT graph_name AS "graphName"
      FROM public.projects
      WHERE id = ${project.id}
    `) as readonly unknown[];
    const projectGraph = parseOptionalAdminActionRow(
      graphNameRows,
      parseAdminActionProjectGraphNameRow,
    );
    if (!projectGraph) {
      throw new Error('Project not found.');
    }

    graphCleanup = await sql.begin(async (tx) => {
      const exclusiveRawDocumentIds = await listExclusiveRawDocumentIds(
        tx,
        project.id,
        dataSourceId,
      );
      const graphNodeIds =
        exclusiveRawDocumentIds.length === 0
          ? []
          : await listDocumentGraphNodeIds(tx, project.id, exclusiveRawDocumentIds);
      storageObjectUris =
        exclusiveRawDocumentIds.length === 0
          ? []
          : await listStorageObjectUris(tx, project.id, exclusiveRawDocumentIds);

      if (exclusiveRawDocumentIds.length > 0) {
        await tx`
          DELETE FROM public.raw_documents
          WHERE project_id = ${project.id}
            AND id IN ${tx(exclusiveRawDocumentIds)}
        `;
      }

      await reassignSharedRawDocumentQueues(tx, project.id, dataSourceId);

      const deleted = (await tx`
        DELETE FROM public.data_sources
        WHERE id = ${dataSourceId}
          AND project_id = ${project.id}
        RETURNING id::text
      `) as readonly unknown[];
      if (!parseOptionalAdminActionIdRow(deleted, 'deleted data source row')) {
        throw new Error('Data source not found in project.');
      }

      return {
        graphName: projectGraph.graphName,
        graphNodeIds,
      };
    });

    await deleteExclusiveDocumentGraphNodes(sql, graphCleanup);
  });

  await deleteStorageObjectsBestEffort(storageObjectUris);
  revalidateProject(projectSlug);
}

export async function retryFailedQueue(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const dataSourceId = formData.get('dataSourceId')?.toString();
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await sql.begin(async (tx) => {
      const dataSourceFilter = dataSourceId ? tx`AND data_source_id = ${dataSourceId}` : tx``;

      await tx`
        UPDATE public.raw_documents
        SET ingest_status = 'fetched',
            ingest_error = null,
            hold_reason = null,
            updated_at = now()
        WHERE project_id = ${project.id}
          AND id IN (
            SELECT raw_document_id
            FROM public.ingestion_queue
            WHERE project_id = ${project.id}
              ${dataSourceFilter}
              AND status IN ('failed', 'held')
          )
      `;

      await tx`
        UPDATE public.ingestion_queue
        SET status = 'pending',
            attempts = 0,
            last_error = null,
            hold_reason = null,
            updated_at = now()
        WHERE project_id = ${project.id}
          ${dataSourceFilter}
          AND status IN ('failed', 'held')
      `;
    });
  });
  revalidateProject(projectSlug);
}

export async function collectDataSource(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const dataSourceId = requireFormValue(formData, 'dataSourceId');
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await collectProjectDataSource(sql, project, dataSourceId, projectSlug);
  });
  revalidateProject(projectSlug);
}

export async function collectAndIngestDataSource(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const dataSourceId = requireFormValue(formData, 'dataSourceId');
  try {
    await runCollectAndIngestDataSource(projectSlug, dataSourceId);
  } finally {
    revalidateProject(projectSlug);
  }
}

export async function ingestDataSource(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const dataSourceId = requireFormValue(formData, 'dataSourceId');
  const { sourceType, storageRoot } = await getProjectDataSourceIngestInput(
    projectSlug,
    dataSourceId,
  );
  try {
    await runIngestWorkflow({ dataSourceId, projectSlug, sourceType, storageRoot });
  } finally {
    revalidateProject(projectSlug);
  }
}

async function ensureDefaultParserProfile(
  sql: SqlExecutor,
  input: {
    readonly approvedByUserId: string;
    readonly dataSourceId: string;
    readonly projectId: string;
    readonly sourceType: SourceType;
  },
): Promise<void> {
  await sql`
    WITH profiles AS (
      INSERT INTO public.parser_profiles AS pp (
        project_id,
        data_source_id,
        source_type,
        name,
        metadata
      )
      VALUES (
        ${input.projectId},
        ${input.dataSourceId},
        ${input.sourceType},
        ${`Built-in ${input.sourceType} parser`},
        ${sql.json({ managedBy: 'apps/web/src/admin-data-source-actions.ts' } as postgres.JSONValue)}
      )
      ON CONFLICT (project_id, data_source_id, source_type, name)
      DO UPDATE SET
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id
    ),
    versions AS (
      INSERT INTO public.parser_versions AS pv (
        parser_profile_id,
        version,
        schema_version,
        artifact_hash,
        contract,
        status,
        approved_by_user_id,
        approved_at
      )
      SELECT
        profiles.id,
        'fixture-parser-v1',
        ${PARSED_SCHEMA_VERSION},
        ${BUILT_IN_PARSER_ARTIFACT_HASH},
        ${sql.json(defaultParserContract(input.sourceType) as postgres.JSONValue)},
        'approved',
        ${input.approvedByUserId},
        now()
      FROM profiles
      ON CONFLICT (parser_profile_id, version)
      DO UPDATE SET
        artifact_hash = EXCLUDED.artifact_hash,
        contract = EXCLUDED.contract,
        status = 'approved',
        approved_by_user_id = EXCLUDED.approved_by_user_id,
        approved_at = COALESCE(pv.approved_at, now()),
        updated_at = now()
      RETURNING id, parser_profile_id
    )
    UPDATE public.parser_profiles AS pp
    SET active_version_id = versions.id,
        updated_at = now()
    FROM versions
    WHERE pp.id = versions.parser_profile_id
  `;
}

class AdminCollectionRepository implements CollectionRepository {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly dataSourceId: string,
  ) {}

  async lookupProjectBySlug(slug: string): Promise<ProjectRecord | undefined> {
    return this.lookupProjectRecordBySlug(slug);
  }

  async findDataSources(projectId: string, sourceType?: SourceType): Promise<DataSourceRecord[]> {
    if (!sourceType) {
      return [];
    }
    return this.listCollectionDataSourceRecords(projectId, sourceType);
  }

  async lookupRawDocument(input: {
    projectId: string;
    sourceId: string;
    sourceType: SourceType;
  }): Promise<RawDocumentRecord | undefined> {
    return this.lookupCollectionRawDocumentRecord(input);
  }

  async findSameHashCandidates(input: {
    contentHash: string;
    projectId: string;
    sourceType: SourceType;
  }): Promise<Array<{ id: string; sourceId: string; sourceType: SourceType }>> {
    return this.listSameHashCandidateRecords(input);
  }

  async upsertRawDocument(input: RawDocumentInput): Promise<RawDocumentRecord> {
    const rawDocument = await this.upsertRawDocumentRecord(input);
    if (!rawDocument) {
      throw new Error(`Failed to upsert raw document: ${input.sourceType}:${input.sourceId}`);
    }
    return rawDocument;
  }

  private async lookupProjectRecordBySlug(slug: string): Promise<ProjectRecord | undefined> {
    const rows = (await this.sql`
      SELECT id::text AS id, slug
      FROM public.projects
      WHERE slug = ${slug}
    `) as readonly unknown[];
    return parseOptionalAdminActionRow(rows, parseAdminActionProjectRecordRow);
  }

  private async listCollectionDataSourceRecords(
    projectId: string,
    sourceType: SourceType,
  ): Promise<DataSourceRecord[]> {
    const rows = (await this.sql`
      SELECT
        config,
        enabled,
        id::text AS id,
        ingest_window AS "ingestWindow",
        project_id::text AS "projectId",
        source_type AS "sourceType"
      FROM public.data_sources
      WHERE project_id = ${projectId}
        AND enabled = true
        AND source_type = ${sourceType}
        AND id = ${this.dataSourceId}
    `) as readonly unknown[];
    return parseAdminActionRows(rows, parseAdminActionDataSourceRecordRow);
  }

  private async lookupCollectionRawDocumentRecord(input: {
    projectId: string;
    sourceId: string;
    sourceType: SourceType;
  }): Promise<RawDocumentRecord | undefined> {
    const rows = (await this.sql`
      SELECT
        id::text AS id,
        ingest_status AS "ingestStatus",
        source_id AS "sourceId",
        source_type AS "sourceType"
      FROM public.raw_documents
      WHERE project_id = ${input.projectId}
        AND source_type = ${input.sourceType}
        AND source_id = ${input.sourceId}
    `) as readonly unknown[];
    return parseOptionalAdminActionRow(rows, parseAdminActionRawDocumentRecordRow);
  }

  private async listSameHashCandidateRecords(input: {
    contentHash: string;
    projectId: string;
    sourceType: SourceType;
  }): Promise<Array<{ id: string; sourceId: string; sourceType: SourceType }>> {
    const rows = (await this.sql`
      SELECT id::text AS id, source_id AS "sourceId", source_type AS "sourceType"
      FROM public.raw_documents
      WHERE project_id = ${input.projectId}
        AND content_hash = ${input.contentHash}
      ORDER BY created_at
    `) as readonly unknown[];
    return parseAdminActionRows(rows, parseAdminActionSameHashCandidateRow);
  }

  private async upsertRawDocumentRecord(
    input: RawDocumentInput,
  ): Promise<RawDocumentRecord | undefined> {
    const rows = (await this.sql`
      INSERT INTO public.raw_documents (
        project_id,
        source_type,
        source_id,
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
        ${input.sourceType},
        ${input.sourceId},
        ${input.sourceUri},
        ${input.storageUri},
        ${input.mimeType},
        ${input.byteSize},
        ${input.contentHash},
        'fetched',
        ${this.sql.json(input.metadata as postgres.JSONValue)}
      )
      ON CONFLICT (project_id, source_type, source_id)
      DO UPDATE SET
        source_uri = EXCLUDED.source_uri,
        storage_uri = EXCLUDED.storage_uri,
        mime_type = EXCLUDED.mime_type,
        byte_size = EXCLUDED.byte_size,
        content_hash = EXCLUDED.content_hash,
        ingest_status = 'fetched',
        ingest_error = null,
        hold_reason = null,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING
        id::text AS id,
        ingest_status AS "ingestStatus",
        source_id AS "sourceId",
        source_type AS "sourceType"
    `) as readonly unknown[];
    return parseOptionalAdminActionRow(rows, parseAdminActionRawDocumentRecordRow);
  }

  async linkDataSource(input: LinkDataSourceInput): Promise<void> {
    await this.sql`
      INSERT INTO public.raw_document_data_sources (
        raw_document_id,
        data_source_id,
        project_id,
        match_reason,
        metadata
      )
      VALUES (
        ${input.rawDocumentId},
        ${input.dataSourceId},
        ${input.projectId},
        ${input.matchReason},
        ${this.sql.json(input.metadata as postgres.JSONValue)}
      )
      ON CONFLICT (raw_document_id, data_source_id)
      DO UPDATE SET
        last_seen_at = now(),
        match_reason = EXCLUDED.match_reason,
        metadata = EXCLUDED.metadata
    `;
  }

  async queueCandidate(input: QueueCandidateInput): Promise<void> {
    await this.sql`
      INSERT INTO public.ingestion_queue (
        project_id,
        data_source_id,
        raw_document_id,
        target_id,
        target_uri,
        status,
        reason
      )
      VALUES (
        ${input.projectId},
        ${input.dataSourceId},
        ${input.rawDocumentId},
        ${input.targetId},
        ${input.targetUri},
        'pending',
        'web-url-collection'
      )
      ON CONFLICT (project_id, raw_document_id)
      DO UPDATE SET
        data_source_id = EXCLUDED.data_source_id,
        target_id = EXCLUDED.target_id,
        target_uri = EXCLUDED.target_uri,
        status = EXCLUDED.status,
        attempts = 0,
        last_error = null,
        hold_reason = null,
        reason = EXCLUDED.reason,
        updated_at = now()
    `;
  }

  async markDataSourceChecked(dataSourceId: string): Promise<void> {
    await this.sql`
      UPDATE public.data_sources
      SET last_checked_at = now(),
          updated_at = now()
      WHERE id = ${dataSourceId}
    `;
  }
}

async function runCollectAndIngestDataSource(
  projectSlug: string,
  dataSourceId: string,
): Promise<void> {
  const { sourceType, storageRoot } = await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await collectProjectDataSource(sql, project, dataSourceId, projectSlug);
    return lookupProjectDataSourceIngestInput(sql, project.id, dataSourceId, projectSlug);
  });
  await runIngestWorkflow({ dataSourceId, projectSlug, sourceType, storageRoot });
}

async function collectProjectDataSource(
  sql: postgres.Sql,
  project: { readonly id: string },
  dataSourceId: string,
  projectSlug: string,
): Promise<void> {
  const dataSource = await lookupProjectDataSource(sql, project.id, dataSourceId);
  if (!isAdminUiCollectionSupported(dataSource.source_type)) {
    throw new Error(`Collect from admin UI is not supported for ${dataSource.source_type} yet.`);
  }
  const connection = await assertDataSourceConnectionReady(
    sql,
    project.id,
    dataSource.source_type,
    dataSource.connectionId,
  );
  if (dataSource.source_type === 'drive' || dataSource.source_type === 'gmail') {
    const token = await readProjectConnectionAccessToken({
      connectionId: connection?.id,
      projectId: project.id,
      provider: 'google',
      sql,
    });
    if (!token) {
      throw new Error(
        `Google ${googleSourceLabel(dataSource.source_type)} access token is not available. Reconnect ${googleSourceLabel(
          dataSource.source_type,
        )} in Settings and try again.`,
      );
    }
    if (dataSource.source_type === 'gmail') {
      await collectGmailSource({
        projectSlug,
        repository: new AdminCollectionRepository(sql, dataSourceId),
        storage: createCollectionStorageFromEnv(),
        token,
      });
      return;
    }
    await collectDriveSource({
      projectSlug,
      repository: new AdminCollectionRepository(sql, dataSourceId),
      storage: createCollectionStorageFromEnv(),
      token,
    });
    return;
  }
  if (dataSource.source_type === 'github') {
    const token = await createGitHubInstallationAccessToken({
      connectionId: connection?.id,
      projectId: project.id,
      sql,
    });
    if (!token) {
      throw new Error(
        'GitHub App installation token is not available. Reconnect GitHub in Settings and verify GitHub App ID and private key are configured.',
      );
    }
    await collectGitHubSource({
      projectSlug,
      repository: new AdminCollectionRepository(sql, dataSourceId),
      storage: createCollectionStorageFromEnv(),
      token,
    });
    return;
  }
  await collectWebUrlSource({
    projectSlug,
    repository: new AdminCollectionRepository(sql, dataSourceId),
    storage: createCollectionStorageFromEnv(),
  });
}

async function getProjectDataSourceIngestInput(
  projectSlug: string,
  dataSourceId: string,
): Promise<{
  readonly sourceType: SourceType;
  readonly storageRoot?: string;
}> {
  return withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    return lookupProjectDataSourceIngestInput(sql, project.id, dataSourceId, projectSlug);
  });
}

async function lookupProjectDataSource(
  sql: postgres.Sql,
  projectId: string,
  dataSourceId: string,
): Promise<AdminActionDataSourceRow> {
  const dataSource = await lookupProjectDataSourceRow(sql, projectId, dataSourceId);
  if (!dataSource) {
    throw new Error('Data source not found in project.');
  }
  return dataSource;
}

async function lookupProjectDataSourceForDeletion(
  sql: postgres.Sql,
  projectId: string,
  dataSourceId: string,
): Promise<AdminActionDataSourceRow> {
  const dataSource = await lookupProjectDataSourceForDeletionRow(sql, projectId, dataSourceId);
  if (!dataSource) {
    throw new Error('Data source not found in project.');
  }
  return dataSource;
}

async function lookupProjectDataSourceForDeletionRow(
  sql: postgres.Sql,
  projectId: string,
  dataSourceId: string,
): Promise<AdminActionDataSourceRow | undefined> {
  const rows = (await sql`
    SELECT connection_id::text AS connection_id, id::text AS id, source_type
    FROM public.data_sources
    WHERE id = ${dataSourceId}
      AND project_id = ${projectId}
  `) as readonly unknown[];
  return parseOptionalAdminActionRow(rows, parseAdminActionDataSourceRow);
}

async function reassignSharedRawDocumentQueues(
  tx: postgres.TransactionSql,
  projectId: string,
  deletedDataSourceId: string,
): Promise<void> {
  await tx`
    UPDATE public.ingestion_queue iq
    SET data_source_id = replacement.data_source_id,
        updated_at = now()
    FROM (
      SELECT DISTINCT ON (rdds.raw_document_id)
        rdds.raw_document_id,
        rdds.data_source_id
      FROM public.raw_document_data_sources rdds
      WHERE rdds.project_id = ${projectId}
        AND rdds.data_source_id <> ${deletedDataSourceId}
        AND EXISTS (
          SELECT 1
          FROM public.raw_document_data_sources deleted_link
          WHERE deleted_link.project_id = ${projectId}
            AND deleted_link.raw_document_id = rdds.raw_document_id
            AND deleted_link.data_source_id = ${deletedDataSourceId}
        )
      ORDER BY rdds.raw_document_id, rdds.data_source_id ASC
    ) replacement
    WHERE iq.project_id = ${projectId}
      AND iq.raw_document_id = replacement.raw_document_id
      AND iq.data_source_id = ${deletedDataSourceId}
  `;
}

async function listExclusiveRawDocumentIds(
  tx: postgres.TransactionSql,
  projectId: string,
  dataSourceId: string,
): Promise<string[]> {
  const rows = (await tx`
    SELECT rdds.raw_document_id::text AS id
    FROM public.raw_document_data_sources rdds
    WHERE rdds.project_id = ${projectId}
      AND rdds.data_source_id = ${dataSourceId}
      AND NOT EXISTS (
        SELECT 1
        FROM public.raw_document_data_sources other
        WHERE other.raw_document_id = rdds.raw_document_id
          AND other.data_source_id <> rdds.data_source_id
      )
  `) as readonly unknown[];
  return parseAdminActionRows(rows, (row) =>
    parseAdminActionIdRow(row, 'exclusive raw document row'),
  ).map((row) => row.id);
}

async function listDocumentGraphNodeIds(
  tx: postgres.TransactionSql,
  projectId: string,
  rawDocumentIds: readonly string[],
): Promise<string[]> {
  const rows = (await tx`
    SELECT d.graph_node_id AS "graphNodeId"
    FROM public.documents d
    WHERE d.project_id = ${projectId}
      AND d.raw_document_id IN ${tx([...rawDocumentIds])}
      AND d.graph_node_id IS NOT NULL
  `) as readonly unknown[];
  return parseAdminActionRows(rows, parseAdminActionDocumentGraphNodeRow).map(
    (row) => row.graphNodeId,
  );
}

async function listStorageObjectUris(
  tx: postgres.TransactionSql,
  projectId: string,
  rawDocumentIds: readonly string[],
): Promise<string[]> {
  const rows = (await tx`
    SELECT
      rd.storage_uri AS "storageUri",
      rd.parsed_uri AS "parsedUri"
    FROM public.raw_documents rd
    WHERE rd.project_id = ${projectId}
      AND rd.id IN ${tx([...rawDocumentIds])}
      AND rd.storage_uri IS NOT NULL
  `) as readonly unknown[];
  const uris = parseAdminActionRows(rows, parseAdminActionStorageObjectUriRow).flatMap((row) =>
    row.parsedUri ? [row.storageUri, row.parsedUri] : [row.storageUri],
  );
  return [...new Set(uris)];
}

async function deleteStorageObjectsBestEffort(uris: readonly string[]): Promise<void> {
  if (uris.length === 0) {
    return;
  }
  try {
    const storage = createCollectionStorageFromEnv();
    if (!storage.delete) {
      console.warn(
        `Storage object cleanup skipped for ${uris.length} object(s): delete unsupported`,
      );
      return;
    }
    const deleteObject = storage.delete.bind(storage);
    const batchSize = 10;
    for (let index = 0; index < uris.length; index += batchSize) {
      const batch = uris.slice(index, index + batchSize);
      await Promise.all(
        batch.map(async (uri) => {
          try {
            await deleteObject(uri);
          } catch (error) {
            console.warn(
              `Storage object cleanup failed for ${uri}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }),
      );
    }
  } catch (error) {
    console.warn(
      `Storage object cleanup skipped for ${uris.length} object(s): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function lookupProjectDataSourceRow(
  sql: postgres.Sql,
  projectId: string,
  dataSourceId: string,
): Promise<AdminActionDataSourceRow | undefined> {
  const rows = (await sql`
    SELECT connection_id::text AS connection_id, id::text AS id, source_type
    FROM public.data_sources
    WHERE id = ${dataSourceId}
      AND project_id = ${projectId}
      AND enabled = true
  `) as readonly unknown[];
  return parseOptionalAdminActionRow(rows, parseAdminActionDataSourceRow);
}

async function lookupProjectDataSourceIngestInput(
  sql: postgres.Sql,
  projectId: string,
  dataSourceId: string,
  projectSlug: string,
): Promise<{
  readonly sourceType: SourceType;
  readonly storageRoot?: string;
}> {
  const dataSource = await lookupProjectDataSourceIngestRow(sql, projectId, dataSourceId);
  if (!dataSource) {
    throw new Error('Data source not found in project.');
  }
  if (!isAdminUiIngestSupported(dataSource.source_type)) {
    throw new Error(`Ingest from admin UI is not supported for ${dataSource.source_type} yet.`);
  }
  await assertDataSourceConnectionReady(
    sql,
    projectId,
    dataSource.source_type,
    dataSource.connectionId,
  );
  return {
    sourceType: dataSource.source_type,
    storageRoot: storageRootFromObjectUri(dataSource.storage_uri, projectSlug),
  };
}

async function lookupProjectDataSourceIngestRow(
  sql: postgres.Sql,
  projectId: string,
  dataSourceId: string,
): Promise<AdminActionDataSourceIngestRow | undefined> {
  const rows = (await sql`
    SELECT
      ds.connection_id::text AS connection_id,
      ds.id::text AS id,
      ds.source_type,
      (
        SELECT rd.storage_uri
        FROM public.raw_document_data_sources rdds
        JOIN public.raw_documents rd ON rd.id = rdds.raw_document_id
        WHERE rdds.data_source_id = ds.id
          AND rd.storage_uri IS NOT NULL
        ORDER BY rd.updated_at DESC
        LIMIT 1
      ) AS storage_uri
    FROM public.data_sources ds
    WHERE ds.id = ${dataSourceId}
      AND ds.project_id = ${projectId}
      AND ds.enabled = true
  `) as readonly unknown[];
  return parseOptionalAdminActionRow(rows, parseAdminActionDataSourceIngestRow);
}

async function runIngestWorkflow(input: {
  readonly dataSourceId: string;
  readonly projectSlug: string;
  readonly sourceType: SourceType;
  readonly storageRoot?: string;
}): Promise<void> {
  const drainOptions = adminIngestDrainOptions();
  if (process.env.NODE_ENV === 'production') {
    await runCloudRunIngestWorkflowJob({ ...input, ...drainOptions });
    return;
  }
  const repoRoot = resolveRepoRoot();
  const workflowScript = resolve(repoRoot, 'scripts/ingest-workflow.ts');
  if (!existsSync(workflowScript)) {
    throw new Error('Cannot locate scripts/ingest-workflow.ts for local ingest workflow.');
  }
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      workflowScript,
      'run',
      '--project',
      input.projectSlug,
      '--source',
      input.sourceType,
      '--data-source-id',
      input.dataSourceId,
      '--resume-from',
      'parse',
      '--drain',
      '--max-batches',
      String(drainOptions.maxBatches),
      '--max-runtime-seconds',
      String(drainOptions.maxRuntimeSeconds),
      '--embedding-provider',
      process.env.PUFU_LENS_ADMIN_INGEST_EMBEDDING_PROVIDER ?? 'deterministic',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL:
          process.env.DATABASE_URL ?? 'postgresql://pufu_lens:pufu_lens@localhost:5432/pufu_lens',
        STORAGE_DRIVER: process.env.STORAGE_DRIVER ?? 'local',
        STORAGE_ROOT:
          input.storageRoot ??
          process.env.STORAGE_ROOT ??
          resolve(repoRoot, '.data/volumes/pufu-lens-data'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(
      `Ingest workflow failed with exit code ${exitCode ?? 'unknown'}: ${truncateWorkflowOutput(
        output.join(''),
      )}`,
    );
  }
}

async function runCloudRunIngestWorkflowJob(input: {
  readonly dataSourceId: string;
  readonly maxBatches: number;
  readonly maxRuntimeSeconds: number;
  readonly projectSlug: string;
  readonly sourceType: SourceType;
}): Promise<void> {
  const projectId = await runtimeProjectId();
  const region = requiredRuntimeEnv('PUFU_LENS_CLOUD_RUN_JOBS_REGION');
  const jobName = process.env.PUFU_LENS_INGEST_WORKFLOW_JOB_NAME ?? 'ingest-workflow';
  const workflowInput = {
    dataSourceId: input.dataSourceId,
    drain: true,
    embeddingProvider: process.env.PUFU_LENS_ADMIN_INGEST_EMBEDDING_PROVIDER ?? 'deterministic',
    maxBatches: input.maxBatches,
    maxRuntimeSeconds: input.maxRuntimeSeconds,
    projectSlug: input.projectSlug,
    resumeFrom: 'parse',
    source: input.sourceType,
  };
  const token = await cloudRunAccessToken();
  const response = await fetch(
    `https://run.googleapis.com/v2/projects/${encodeURIComponent(
      projectId,
    )}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(jobName)}:run`,
    {
      body: JSON.stringify({
        overrides: {
          containerOverrides: [
            {
              env: [
                {
                  name: 'WORKFLOW_INPUT_JSON',
                  value: JSON.stringify(workflowInput),
                },
              ],
            },
          ],
        },
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    },
  );
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `Cloud Run ingest workflow job failed to start: HTTP ${response.status} - ${truncateWorkflowOutput(
        errorText,
      )}`,
    );
  }
  const body = (await response.json().catch(() => ({}))) as CloudRunJobRunResponse;
  console.info(
    `Started Cloud Run ingest workflow job ${jobName} for ${input.projectSlug}/${input.dataSourceId}: ${
      body.name ?? '<unknown execution>'
    }`,
  );
}

async function cloudRunAccessToken(): Promise<string> {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error('Failed to acquire Google Cloud access token for Cloud Run Jobs API.');
  }
  return token;
}

function adminIngestDrainOptions(): { maxBatches: number; maxRuntimeSeconds: number } {
  return {
    maxBatches: readPositiveIntegerEnv(
      'PUFU_LENS_ADMIN_INGEST_DRAIN_MAX_BATCHES',
      DEFAULT_ADMIN_INGEST_DRAIN_MAX_BATCHES,
    ),
    maxRuntimeSeconds: readPositiveIntegerEnv(
      'PUFU_LENS_ADMIN_INGEST_DRAIN_MAX_RUNTIME_SECONDS',
      DEFAULT_ADMIN_INGEST_DRAIN_MAX_RUNTIME_SECONDS,
    ),
  };
}

async function runtimeProjectId(): Promise<string> {
  const envProjectId =
    process.env.PUFU_LENS_GCP_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCLOUD_PROJECT ??
    process.env.GCP_PROJECT;
  if (envProjectId) {
    return envProjectId.trim();
  }
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/project/project-id',
    {
      headers: { 'metadata-flavor': 'Google' },
      signal: AbortSignal.timeout(2000),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to read GCP project id from metadata server: HTTP ${response.status}`);
  }
  return (await response.text()).trim();
}

function requiredRuntimeEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function storageRootFromObjectUri(uri: string | null, projectSlug: string): string | undefined {
  if (!uri?.startsWith('file://')) {
    return undefined;
  }
  const path = fileURLToPath(uri);
  const marker = `/${projectSlug}/`;
  const markerIndex = path.indexOf(marker);
  return markerIndex > 0 ? path.slice(0, markerIndex) : undefined;
}

function resolveRepoRoot(): string {
  const candidates = [process.cwd(), resolve(process.cwd(), '../..')];
  const repoRoot = candidates.find((candidate) =>
    existsSync(resolve(candidate, 'scripts/ingest-workflow.ts')),
  );
  if (!repoRoot) {
    throw new Error('Cannot locate repository root for ingest workflow.');
  }
  return repoRoot;
}

function truncateWorkflowOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= 2000) {
    return trimmed;
  }
  return trimmed.slice(-2000);
}

function requireSourceType(value: string): SourceType {
  if (isSourceType(value)) {
    return value;
  }
  throw new Error(`Unsupported source type: ${value}`);
}

function buildDataSourceConfig(sourceType: SourceType, scope: string): Record<string, unknown> {
  if (sourceType === 'web') {
    return {
      source: 'admin-ui',
      urls: splitScopeList(scope),
    };
  }
  if (sourceType === 'github') {
    return {
      includeIssues: false,
      includeLinkedIssues: true,
      includePullRequests: true,
      maxLinkedIssues: 500,
      maxPullRequests: 500,
      pullRequestState: 'all',
      repositories: splitScopeList(scope),
      source: 'admin-ui',
    };
  }
  if (sourceType === 'drive') {
    return {
      folderId: scope,
      source: 'admin-ui',
    };
  }
  return {
    query: scope,
    source: 'admin-ui',
  };
}

function googleSourceLabel(sourceType: SourceType): string {
  return sourceType === 'gmail' ? 'Gmail' : 'Drive';
}

function createCollectionStorageFromEnv(): ObjectStorage {
  return createObjectStorageFromEnv(process.env);
}

function splitScopeList(value: string): readonly string[] {
  const items = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error('scope is required.');
  }
  return items;
}
