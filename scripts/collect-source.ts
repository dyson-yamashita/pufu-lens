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
} from '../packages/ingestion/dist/index.js';
import { LocalFsObjectStorage } from '../packages/storage/dist/local-fs.js';

const SOURCE_TYPES = ['drive', 'github', 'gmail', 'web'] as const;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const sourceType = requiredOption(options.source, '--source');

  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  const storage = createLocalObjectStorageFromEnv();
  const repository = new PostgresCollectionRepository(sql);

  try {
    if (sourceType === 'web' && options.urls.length > 0) {
      await ensureWebUrlDataSource({ projectSlug, sql, urls: options.urls });
    }
    if (sourceType === 'github' && options.repositories.length > 0) {
      await ensureGitHubDataSource({
        projectSlug,
        repositories: options.repositories,
        sql,
        state: options.state,
      });
    }
    if (sourceType === 'drive' && (options.folderIds.length > 0 || options.folderUrls.length > 0)) {
      await ensureDriveDataSource({
        folderIds: options.folderIds,
        folderUrls: options.folderUrls,
        projectSlug,
        sql,
      });
    }
    if (sourceType === 'gmail' && (options.labelIds.length > 0 || options.query)) {
      await ensureGmailDataSource({
        labelIds: options.labelIds,
        projectSlug,
        query: options.query,
        sql,
      });
    }

    const result =
      sourceType === 'drive'
        ? await collectDriveSource({
            dryRun: options.dryRun,
            limit: options.limit,
            projectSlug,
            repository,
            storage,
            token: process.env.GOOGLE_DRIVE_ACCESS_TOKEN ?? process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
          })
        : sourceType === 'gmail'
          ? await collectGmailSource({
              dryRun: options.dryRun,
              limit: options.limit,
              projectSlug,
              repository,
              storage,
              token: process.env.GMAIL_ACCESS_TOKEN ?? process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
            })
          : sourceType === 'github'
            ? await collectGitHubSource({
                dryRun: options.dryRun,
                limit: options.limit,
                projectSlug,
                repository,
                storage,
                token: process.env.GITHUB_TOKEN,
              })
            : await collectWebUrlSource({
                dryRun: options.dryRun,
                limit: options.limit,
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

  async findDataSources(projectId: string, sourceType?: SourceType): Promise<DataSourceRecord[]> {
    if (!sourceType) {
      return [];
    }
    return (await this.sql`
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
      ORDER BY source_type, name
    `) as DataSourceRecord[];
  }

  async lookupRawDocument(input: {
    projectId: string;
    sourceId: string;
    sourceType: SourceType;
  }): Promise<RawDocumentRecord | undefined> {
    return singleJson(
      (await this.sql`
        SELECT
          id::text AS id,
          ingest_status AS "ingestStatus",
          source_id AS "sourceId",
          source_type AS "sourceType"
        FROM public.raw_documents
        WHERE project_id = ${input.projectId}
          AND source_type = ${input.sourceType}
          AND source_id = ${input.sourceId}
      `) as RawDocumentRecord[],
    );
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

  async upsertRawDocument(input: RawDocumentInput): Promise<RawDocumentRecord> {
    const rawDocument = singleJson(
      (await this.sql`
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
          metadata = EXCLUDED.metadata
        RETURNING
          id::text AS id,
          ingest_status AS "ingestStatus",
          source_id AS "sourceId",
          source_type AS "sourceType"
      `) as RawDocumentRecord[],
    );

    if (!rawDocument) {
      throw new Error(`Failed to upsert raw document: ${input.sourceType}:${input.sourceId}`);
    }

    return rawDocument;
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
      ingest_window
    )
    SELECT
      project.id,
      '00000000-0000-0000-0000-000000000001',
      'github',
      'GitHub repositories',
      ${input.sql.json({
        repositories: input.repositories,
        state: input.state ?? 'open',
      })},
      ${input.sql.json({})}
    FROM project
    ON CONFLICT (project_id, source_type, name)
    DO UPDATE SET
      enabled = true,
      config = EXCLUDED.config,
      ingest_window = EXCLUDED.ingest_window
  `;
}

async function ensureDriveDataSource(input: {
  folderIds: string[];
  folderUrls: string[];
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
      ingest_window
    )
    SELECT
      project.id,
      '00000000-0000-0000-0000-000000000001',
      'drive',
      'Drive folders',
      ${input.sql.json({
        folderIds: input.folderIds,
        folderUrls: input.folderUrls,
      })},
      ${input.sql.json({})}
    FROM project
    ON CONFLICT (project_id, source_type, name)
    DO UPDATE SET
      enabled = true,
      config = EXCLUDED.config,
      ingest_window = EXCLUDED.ingest_window
  `;
}

async function ensureGmailDataSource(input: {
  labelIds: string[];
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
      ingest_window
    )
    SELECT
      project.id,
      '00000000-0000-0000-0000-000000000001',
      'gmail',
      'Gmail messages',
      ${input.sql.json({
        labelIds: input.labelIds,
        query: input.query,
      })},
      ${input.sql.json({})}
    FROM project
    ON CONFLICT (project_id, source_type, name)
    DO UPDATE SET
      enabled = true,
      config = EXCLUDED.config,
      ingest_window = EXCLUDED.ingest_window
  `;
}

function createLocalObjectStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LocalFsObjectStorage {
  const driver = env.STORAGE_DRIVER ?? env.OBJECT_STORAGE_DRIVER ?? 'local';
  if (driver !== 'local') {
    throw new Error(`Unsupported object storage driver for real collection CLI: ${driver}`);
  }

  const root = env.STORAGE_ROOT ?? env.LOCAL_STORAGE_ROOT;
  if (!root) {
    throw new Error('STORAGE_ROOT or LOCAL_STORAGE_ROOT is required for local object storage.');
  }

  return new LocalFsObjectStorage(root);
}

function parseArgs(args: string[]): {
  folderIds: string[];
  folderUrls: string[];
  labelIds: string[];
  project?: string;
  query?: string;
  repositories: string[];
  source?: string;
  state?: 'all' | 'closed' | 'open';
  urls: string[];
  limit?: number;
  dryRun?: boolean;
} {
  const options: {
    folderIds: string[];
    folderUrls: string[];
    labelIds: string[];
    project?: string;
    query?: string;
    repositories: string[];
    source?: string;
    state?: 'all' | 'closed' | 'open';
    urls: string[];
    limit?: number;
    dryRun?: boolean;
  } = { folderIds: [], folderUrls: [], labelIds: [], repositories: [], urls: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--project') {
      options.project = readOptionValue(args, ++index, arg);
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
  if (!/^[A-Za-z0-9_:-]+$/.test(value)) {
    throw new Error(`${name} must be a Gmail label id: ${value}`);
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredOption(value: string | undefined, optionName: string): string {
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
