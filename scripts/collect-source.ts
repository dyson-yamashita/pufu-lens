import postgres from 'postgres';
import type {
  CollectionRepository,
  DataSourceRecord,
  LinkDataSourceInput,
  ProjectRecord,
  QueueCandidateInput,
  RawDocumentInput,
  RawDocumentRecord,
  SourceType,
} from '../packages/ingestion/dist/index.js';
import {
  collectDriveSource,
  collectGitHubSource,
  collectGmailSource,
  collectWebUrlSource,
  parseCollectionDataSourceRecordRows,
  parseOptionalCollectionRawDocumentRecordRow,
} from '../packages/ingestion/dist/index.js';
import { createObjectStorageFromEnv } from '../packages/storage/dist/factory.js';
import type { ObjectStorage } from '../packages/storage/dist/object-storage.js';
import { requiredEnv } from './lib/cli.ts';
import {
  providerForSource,
  readCollectionConnection,
  readProjectCollectionConnection,
  requiredCollectionToken,
} from './lib/collection-connection.ts';

const SOURCE_TYPES = ['drive', 'github', 'gmail', 'web'] as const;
const DEFAULT_COLLECT_LIMIT = 100;

type RealSourceType = (typeof SOURCE_TYPES)[number];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sourceType = requiredOption(options.source, '--source');
  const limit = options.limit ?? DEFAULT_COLLECT_LIMIT;

  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createObjectStorageForCollection();
  const repository = new PostgresCollectionRepository(sql);

  try {
    const provider = providerForSource(sourceType);
    const connection = options.connectionId
      ? await readCollectionConnection({
          connectionId: options.connectionId,
          dataSourceId: options.dataSourceId,
          projectSlug,
          provider:
            provider ??
            (() => {
              throw new Error(
                '--connection-id is supported only for gmail, drive, and github sources.',
              );
            })(),
          sourceType: sourceType as Exclude<RealSourceType, 'web'>,
          sql,
        })
      : provider
        ? await readProjectCollectionConnection({
            dataSourceId: options.dataSourceId,
            projectSlug,
            provider,
            sourceType: sourceType as Exclude<RealSourceType, 'web'>,
            sql,
          })
        : undefined;

    const connectionToken =
      sourceType === 'web' ? undefined : requiredCollectionToken(sourceType, connection);

    if (sourceType === 'web' && options.urls.length > 0) {
      await ensureWebUrlDataSource({ projectSlug, sql, urls: options.urls });
    }
    if (sourceType === 'github' && options.repositories.length > 0) {
      await ensureGitHubDataSource({
        connectionId: connection?.id,
        ownerUserId: connection?.userId,
        projectSlug,
        repositories: options.repositories,
        sql,
        state: options.state,
      });
    }
    if (sourceType === 'drive' && (options.folderIds.length > 0 || options.folderUrls.length > 0)) {
      await ensureDriveDataSource({
        connectionId: connection?.id,
        folderIds: options.folderIds,
        folderUrls: options.folderUrls,
        ownerUserId: connection?.userId,
        projectSlug,
        sql,
      });
    }
    if (sourceType === 'gmail' && (options.labelIds.length > 0 || options.query)) {
      await ensureGmailDataSource({
        connectionId: connection?.id,
        labelIds: options.labelIds,
        ownerUserId: connection?.userId,
        projectSlug,
        query: options.query,
        sql,
      });
    }

    const result =
      sourceType === 'drive'
        ? await collectDriveSource({
            dataSourceId: options.dataSourceId,
            dryRun: options.dryRun,
            limit,
            projectSlug,
            repository,
            storage,
            token: connectionToken,
          })
        : sourceType === 'gmail'
          ? await collectGmailSource({
              dataSourceId: options.dataSourceId,
              dryRun: options.dryRun,
              limit,
              projectSlug,
              repository,
              storage,
              token: connectionToken,
            })
          : sourceType === 'github'
            ? await collectGitHubSource({
                dataSourceId: options.dataSourceId,
                dryRun: options.dryRun,
                limit,
                projectSlug,
                repository,
                storage,
                token: connectionToken,
              })
            : await collectWebUrlSource({
                dataSourceId: options.dataSourceId,
                dryRun: options.dryRun,
                limit,
                projectSlug,
                repository,
                storage,
              });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql.end();
  }
}

class PostgresCollectionRepository implements CollectionRepository {
  private sql: postgres.Sql;
  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  async lookupProjectBySlug(slug: string): Promise<ProjectRecord | undefined> {
    return singleJson(
      (await this.sql`
        SELECT id::text AS id, slug
        FROM public.projects
        WHERE slug = ${slug}
      `) as ProjectRecord[],
    );
  }

  async findDataSources(
    projectId: string,
    sourceType?: SourceType,
    dataSourceId?: string,
  ): Promise<DataSourceRecord[]> {
    if (!sourceType) {
      return [];
    }
    const rows = (await this.sql`
      SELECT
        config,
        enabled,
        id::text AS id,
        ingest_window AS "ingestWindow",
        last_sync_succeeded_at AS "lastSyncSucceededAt",
        project_id::text AS "projectId",
        source_type AS "sourceType",
        sync_cursor AS "syncCursor"
      FROM public.data_sources
      WHERE project_id = ${projectId}
        AND enabled = true
        AND source_type = ${sourceType}
        AND (${dataSourceId ?? null}::uuid IS NULL OR id = ${dataSourceId ?? null}::uuid)
      ORDER BY source_type, name
    `) as readonly unknown[];
    return parseCollectionDataSourceRecordRows(rows);
  }

  async lookupRawDocument(input: {
    projectId: string;
    sourceId: string;
    sourceType: SourceType;
  }): Promise<RawDocumentRecord | undefined> {
    const rows = (await this.sql`
      SELECT
        id::text AS id,
        ingest_status AS "ingestStatus",
        logical_source_id AS "logicalSourceId",
        source_id AS "sourceId",
        source_type AS "sourceType",
        source_version AS "sourceVersion"
      FROM public.raw_documents
      WHERE project_id = ${input.projectId}
        AND source_type = ${input.sourceType}
        AND source_id = ${input.sourceId}
    `) as readonly unknown[];
    return parseOptionalCollectionRawDocumentRecordRow(rows);
  }

  async lookupRawDocumentVersion(input: {
    logicalSourceId: string;
    projectId: string;
    sourceType: SourceType;
    sourceVersion: string;
  }): Promise<RawDocumentRecord | undefined> {
    const rows = (await this.sql`
      SELECT
        id::text AS id,
        ingest_status AS "ingestStatus",
        logical_source_id AS "logicalSourceId",
        source_id AS "sourceId",
        source_type AS "sourceType",
        source_version AS "sourceVersion"
      FROM public.raw_documents
      WHERE project_id = ${input.projectId}
        AND source_type = ${input.sourceType}
        AND logical_source_id = ${input.logicalSourceId}
        AND source_version = ${input.sourceVersion}
    `) as readonly unknown[];
    return parseOptionalCollectionRawDocumentRecordRow(rows);
  }

  async findSameHashCandidates(input: {
    contentHash: string;
    projectId: string;
    sourceType: SourceType;
  }): Promise<Array<{ id: string; sourceId: string; sourceType: SourceType }>> {
    return (await this.sql`
      SELECT id::text AS id, source_id AS "sourceId", source_type AS "sourceType"
      FROM public.raw_documents
      WHERE project_id = ${input.projectId}
        AND content_hash = ${input.contentHash}
      ORDER BY created_at
    `) as Array<{ id: string; sourceId: string; sourceType: SourceType }>;
  }

  async upsertRawDocument(input: RawDocumentInput) {
    const rows = (await this.sql`
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
          ${input.sourceType},
          ${input.sourceId},
          ${input.logicalSourceId},
          ${input.sourceVersion},
          ${input.sourceUri},
          ${input.storageUri},
          ${input.mimeType},
          ${input.byteSize},
          ${input.contentHash},
          'fetched',
          ${this.sql.json(input.metadata as postgres.JSONValue)}
        )
        ON CONFLICT (project_id, source_type, logical_source_id, source_version)
        DO NOTHING
        RETURNING
          id::text AS id,
          ingest_status AS "ingestStatus",
          logical_source_id AS "logicalSourceId",
          source_id AS "sourceId",
          source_type AS "sourceType",
          source_version AS "sourceVersion"
      `) as readonly unknown[];
    const rawDocument = parseOptionalCollectionRawDocumentRecordRow(rows);

    if (rawDocument) {
      return { inserted: true, rawDocument };
    }
    const existing = await this.lookupRawDocumentVersion(input);
    if (!existing) {
      throw new Error(`Failed to store raw document: ${input.sourceType}:${input.sourceId}`);
    }
    return { inserted: false, rawDocument: existing };
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
        (
          SELECT CASE
            WHEN source_type = 'web' THEN 'web-url-collection'
            ELSE source_type || '-collection'
          END
          FROM public.raw_documents
          WHERE id = ${input.rawDocumentId}
        )
      )
      ON CONFLICT (project_id, raw_document_id)
      DO UPDATE SET
        data_source_id = EXCLUDED.data_source_id,
        target_id = EXCLUDED.target_id,
        target_uri = EXCLUDED.target_uri,
        status = EXCLUDED.status,
        attempts = 0,
        last_error = null,
        reason = EXCLUDED.reason
    `;
  }

  async markDataSourceChecked(dataSourceId: string): Promise<void> {
    await this.sql`
      UPDATE public.data_sources
      SET last_checked_at = now()
      WHERE id = ${dataSourceId}
    `;
  }

  async completeDataSourceSync(input: {
    dataSourceId: string;
    projectId: string;
    syncCursor: Record<string, unknown>;
  }): Promise<void> {
    await this.sql`
      UPDATE public.data_sources
      SET
        last_checked_at = now(),
        last_sync_succeeded_at = now(),
        sync_cursor = ${this.sql.json(input.syncCursor as postgres.JSONValue)},
        updated_at = now()
      WHERE id = ${input.dataSourceId}
        AND project_id = ${input.projectId}
    `;
  }
}

async function ensureWebUrlDataSource(input: {
  projectSlug: string;
  sql: postgres.Sql;
  urls: string[];
}): Promise<void> {
  await input.sql`
    WITH project AS (
      SELECT id FROM public.projects WHERE slug = ${input.projectSlug}
    )
    INSERT INTO public.data_sources (
      project_id,
      owner_user_id,
      source_type,
      name,
      config,
      ingest_window
    )
    SELECT
      project.id,
      '00000000-0000-0000-0000-000000000001',
      'web',
      'Web URLs',
      ${input.sql.json({ urls: input.urls })},
      ${input.sql.json({})}
    FROM project
    ON CONFLICT (project_id, source_type, name)
    DO UPDATE SET
      enabled = true,
      config = EXCLUDED.config,
      ingest_window = EXCLUDED.ingest_window
  `;
}

async function ensureGitHubDataSource(input: {
  connectionId?: string;
  ownerUserId?: string;
  projectSlug: string;
  repositories: string[];
  sql: postgres.Sql;
  state?: 'all' | 'closed' | 'open';
}): Promise<void> {
  await input.sql`
    WITH project AS (
      SELECT id FROM public.projects WHERE slug = ${input.projectSlug}
    )
    INSERT INTO public.data_sources (
      project_id,
      owner_user_id,
      source_type,
      name,
      config,
      ingest_window,
      connection_id
    )
    SELECT
      project.id,
      ${input.ownerUserId ?? '00000000-0000-0000-0000-000000000001'},
      'github',
      'GitHub repositories',
      ${input.sql.json({
        repositories: input.repositories,
        state: input.state ?? 'open',
      })},
      ${input.sql.json({})},
      ${input.connectionId ?? null}
    FROM project
    ON CONFLICT (project_id, source_type, name)
    DO UPDATE SET
      enabled = true,
      config = EXCLUDED.config,
      ingest_window = EXCLUDED.ingest_window,
      owner_user_id = CASE
        WHEN EXCLUDED.connection_id IS NULL THEN data_sources.owner_user_id
        ELSE EXCLUDED.owner_user_id
      END,
      connection_id = COALESCE(EXCLUDED.connection_id, data_sources.connection_id)
  `;
}

async function ensureDriveDataSource(input: {
  connectionId?: string;
  folderIds: string[];
  folderUrls: string[];
  ownerUserId?: string;
  projectSlug: string;
  sql: postgres.Sql;
}): Promise<void> {
  await input.sql`
    WITH project AS (
      SELECT id FROM public.projects WHERE slug = ${input.projectSlug}
    )
    INSERT INTO public.data_sources (
      project_id,
      owner_user_id,
      source_type,
      name,
      config,
      ingest_window,
      connection_id
    )
    SELECT
      project.id,
      ${input.ownerUserId ?? '00000000-0000-0000-0000-000000000001'},
      'drive',
      'Drive folders',
      ${input.sql.json({
        folderIds: input.folderIds,
        folderUrls: input.folderUrls,
      })},
      ${input.sql.json({})},
      ${input.connectionId ?? null}
    FROM project
    ON CONFLICT (project_id, source_type, name)
    DO UPDATE SET
      enabled = true,
      config = EXCLUDED.config,
      ingest_window = EXCLUDED.ingest_window,
      owner_user_id = CASE
        WHEN EXCLUDED.connection_id IS NULL THEN data_sources.owner_user_id
        ELSE EXCLUDED.owner_user_id
      END,
      connection_id = COALESCE(EXCLUDED.connection_id, data_sources.connection_id)
  `;
}

async function ensureGmailDataSource(input: {
  connectionId?: string;
  labelIds: string[];
  ownerUserId?: string;
  projectSlug: string;
  query?: string;
  sql: postgres.Sql;
}): Promise<void> {
  await input.sql`
    WITH project AS (
      SELECT id FROM public.projects WHERE slug = ${input.projectSlug}
    )
    INSERT INTO public.data_sources (
      project_id,
      owner_user_id,
      source_type,
      name,
      config,
      ingest_window,
      connection_id
    )
    SELECT
      project.id,
      ${input.ownerUserId ?? '00000000-0000-0000-0000-000000000001'},
      'gmail',
      'Gmail messages',
      ${input.sql.json({
        labelIds: input.labelIds,
        query: input.query,
      })},
      ${input.sql.json({})},
      ${input.connectionId ?? null}
    FROM project
    ON CONFLICT (project_id, source_type, name)
    DO UPDATE SET
      enabled = true,
      config = EXCLUDED.config,
      ingest_window = EXCLUDED.ingest_window,
      owner_user_id = CASE
        WHEN EXCLUDED.connection_id IS NULL THEN data_sources.owner_user_id
        ELSE EXCLUDED.owner_user_id
      END,
      connection_id = COALESCE(EXCLUDED.connection_id, data_sources.connection_id)
  `;
}

function createObjectStorageForCollection(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  return createObjectStorageFromEnv(env);
}

function parseArgs(args: string[]): {
  folderIds: string[];
  folderUrls: string[];
  labelIds: string[];
  connectionId?: string;
  dataSourceId?: string;
  project?: string;
  query?: string;
  repositories: string[];
  source?: RealSourceType;
  state?: 'all' | 'closed' | 'open';
  urls: string[];
  limit?: number;
  dryRun?: boolean;
} {
  const options: {
    folderIds: string[];
    folderUrls: string[];
    labelIds: string[];
    connectionId?: string;
    dataSourceId?: string;
    project?: string;
    query?: string;
    repositories: string[];
    source?: RealSourceType;
    state?: 'all' | 'closed' | 'open';
    urls: string[];
    limit?: number;
    dryRun?: boolean;
  } = { folderIds: [], folderUrls: [], labelIds: [], repositories: [], urls: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--project') {
      options.project = readOptionValue(args, ++index, arg);
    } else if (arg === '--connection-id') {
      options.connectionId = readUuid(readOptionValue(args, ++index, arg), arg);
    } else if (arg === '--data-source-id') {
      options.dataSourceId = readUuid(readOptionValue(args, ++index, arg), arg);
    } else if (arg === '--source') {
      const sourceType = readOptionValue(args, ++index, arg);
      if (!isRealSourceType(sourceType)) {
        throw new Error(`Unsupported --source value: ${sourceType}`);
      }
      options.source = sourceType;
    } else if (arg === '--repo' || arg === '--repository') {
      options.repositories.push(readRepository(readOptionValue(args, ++index, arg), arg));
    } else if (arg === '--state') {
      options.state = readGitHubState(readOptionValue(args, ++index, arg), arg);
    } else if (arg === '--folder-id') {
      options.folderIds.push(readDriveFolderId(readOptionValue(args, ++index, arg), arg));
    } else if (arg === '--folder-url') {
      options.folderUrls.push(readOptionValue(args, ++index, arg));
    } else if (arg === '--label' || arg === '--label-id') {
      options.labelIds.push(readGmailLabelId(readOptionValue(args, ++index, arg), arg));
    } else if (arg === '--query' || arg === '--gmail-query') {
      options.query = readOptionValue(args, ++index, arg);
    } else if (arg === '--url') {
      options.urls.push(readOptionValue(args, ++index, arg));
    } else if (arg === '--limit') {
      options.limit = readPositiveInteger(readOptionValue(args, ++index, arg), arg);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readDriveFolderId(value: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${name} must be a Google Drive folder id: ${value}`);
  }
  return value;
}

function readGmailLabelId(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function readGitHubState(value: string, name: string): 'all' | 'closed' | 'open' {
  if (value !== 'all' && value !== 'closed' && value !== 'open') {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return value;
}

function isRealSourceType(value: string): value is (typeof SOURCE_TYPES)[number] {
  return (SOURCE_TYPES as readonly string[]).includes(value);
}

function readUuid(value: string, name: string): string {
  assertUuid(value, name);
  return value;
}

function assertUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a valid UUID.`);
  }
}

function readRepository(value: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${name} must be owner/repo: ${value}`);
  }
  return value;
}

function readOptionValue(args: string[], index: number, optionName: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }

  return value;
}

function readPositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
}

function requiredOption<T extends string>(value: T | undefined, optionName: string): T {
  if (!value) {
    throw new Error(`${optionName} is required.`);
  }
  return value;
}

function singleJson<T>(rows: T[]): T | undefined {
  return rows[0];
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
