import { createCipheriv, createDecipheriv, createHash, createSign, randomBytes } from 'node:crypto';
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
import { createObjectStorageFromEnv } from '../packages/storage/dist/factory.js';
import type { ObjectStorage } from '../packages/storage/dist/object-storage.js';
import { requiredEnv } from './lib/cli.ts';

const SOURCE_TYPES = ['drive', 'github', 'gmail', 'web'] as const;
const DEFAULT_COLLECT_LIMIT = 100;
const ENCRYPTED_CONNECTION_SECRET_PREFIX = 'encrypted:';

type RealSourceType = (typeof SOURCE_TYPES)[number];
type ConnectionProvider = 'github' | 'google';

interface CollectionConnection {
  id: string;
  provider: ConnectionProvider;
  token: string;
  userId: string;
}

interface GoogleTokenResponse {
  readonly access_token?: string;
  readonly expires_in?: number;
}

type EncryptedConnectionSecret = {
  readonly alg: 'aes-256-gcm';
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
};

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
          projectSlug,
          provider,
          sourceType,
          sql,
        })
      : provider
        ? await readProjectCollectionConnection({ projectSlug, provider, sourceType, sql })
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
            dryRun: options.dryRun,
            limit,
            projectSlug,
            repository,
            storage,
            token: connectionToken,
          })
        : sourceType === 'gmail'
          ? await collectGmailSource({
              dryRun: options.dryRun,
              limit,
              projectSlug,
              repository,
              storage,
              token: connectionToken,
            })
          : sourceType === 'github'
            ? await collectGitHubSource({
                dryRun: options.dryRun,
                limit,
                projectSlug,
                repository,
                storage,
                token: connectionToken,
              })
            : await collectWebUrlSource({
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

function providerForSource(sourceType: RealSourceType): ConnectionProvider | undefined {
  if (sourceType === 'drive' || sourceType === 'gmail') {
    return 'google';
  }
  if (sourceType === 'github') {
    return 'github';
  }
  return undefined;
}

function requiredCollectionToken(
  sourceType: Exclude<RealSourceType, 'web'>,
  connection: CollectionConnection | undefined,
): string {
  if (!connection?.token) {
    throw new Error(
      `${sourceType} collection requires a configured OAuth connection for this project. Connect the source in Settings or pass --connection-id.`,
    );
  }
  return connection.token;
}

function requiredScopeForSourceType(sourceType: RealSourceType): string | undefined {
  if (sourceType === 'gmail') {
    return 'https://www.googleapis.com/auth/gmail.readonly';
  }
  if (sourceType === 'drive') {
    return 'https://www.googleapis.com/auth/drive.readonly';
  }
  return undefined;
}

async function readProjectCollectionConnection(input: {
  projectSlug: string;
  provider: ConnectionProvider;
  sourceType: RealSourceType;
  sql: postgres.Sql;
}): Promise<CollectionConnection | undefined> {
  const sourceScope = requiredScopeForSourceType(input.sourceType);
  const scopeFilter = sourceScope ? input.sql`${sourceScope} = ANY(oc.scopes)` : input.sql`true`;
  const githubFilter =
    input.provider === 'github' ? input.sql`AND oc.metadata ? 'installationId'` : input.sql``;
  const rows = (await input.sql`
    SELECT
      oc.id::text AS id,
      oc.provider,
      oc.user_id::text AS "userId",
      oc.access_token_secret AS "accessTokenSecret",
      oc.refresh_token_secret AS "refreshTokenSecret",
      oc.expires_at AS "expiresAt",
      oc.metadata
    FROM public.oauth_connections oc
    JOIN public.projects p ON p.id = oc.project_id
    WHERE p.slug = ${input.projectSlug}
      AND oc.provider = ${input.provider}
      AND (oc.expires_at IS NULL OR oc.expires_at > now())
      AND (oc.metadata->>'connectionError') IS DISTINCT FROM 'true'
      AND (oc.metadata->>'scopeMissing') IS DISTINCT FROM 'true'
      AND COALESCE(oc.metadata->>'status', '') NOT IN ('error', 'scope_missing')
      AND ${scopeFilter}
      ${githubFilter}
    LIMIT 1
  `) as Array<{
    accessTokenSecret: string | null;
    expiresAt: Date | string | null;
    id: string;
    metadata: unknown;
    provider: ConnectionProvider;
    refreshTokenSecret: string | null;
    userId: string;
  }>;
  const connection = rows[0];
  if (!connection) {
    return undefined;
  }
  return {
    id: connection.id,
    provider: connection.provider,
    token: await resolveConnectionToken({ connection, sql: input.sql }),
    userId: connection.userId,
  };
}

async function readCollectionConnection(input: {
  connectionId: string;
  projectSlug: string;
  provider?: ConnectionProvider;
  sourceType: RealSourceType;
  sql: postgres.Sql;
}): Promise<CollectionConnection> {
  if (!input.provider) {
    throw new Error('--connection-id is supported only for gmail, drive, and github sources.');
  }
  assertUuid(input.connectionId, '--connection-id');
  const sourceScope = requiredScopeForSourceType(input.sourceType);
  const scopeFilter = sourceScope ? input.sql`${sourceScope} = ANY(oc.scopes)` : input.sql`true`;
  const githubFilter =
    input.provider === 'github' ? input.sql`AND oc.metadata ? 'installationId'` : input.sql``;
  const rows = (await input.sql`
    SELECT
      oc.id::text AS id,
      oc.provider,
      oc.user_id::text AS "userId",
      oc.access_token_secret AS "accessTokenSecret",
      oc.refresh_token_secret AS "refreshTokenSecret",
      oc.expires_at AS "expiresAt",
      oc.metadata
    FROM public.oauth_connections oc
    JOIN public.projects p ON p.id = oc.project_id
    WHERE oc.id = ${input.connectionId}
      AND p.slug = ${input.projectSlug}
      AND oc.provider = ${input.provider}
      AND (oc.expires_at IS NULL OR oc.expires_at > now())
      AND (oc.metadata->>'connectionError') IS DISTINCT FROM 'true'
      AND (oc.metadata->>'scopeMissing') IS DISTINCT FROM 'true'
      AND COALESCE(oc.metadata->>'status', '') NOT IN ('error', 'scope_missing')
      AND ${scopeFilter}
      ${githubFilter}
    LIMIT 1
  `) as Array<{
    accessTokenSecret: string | null;
    expiresAt: Date | string | null;
    id: string;
    metadata: unknown;
    provider: ConnectionProvider;
    refreshTokenSecret: string | null;
    userId: string;
  }>;
  const connection = rows[0];
  if (!connection) {
    throw new Error('OAuth connection was not found for the project and source type.');
  }
  return {
    id: connection.id,
    provider: connection.provider,
    token: await resolveConnectionToken({ connection, sql: input.sql }),
    userId: connection.userId,
  };
}

async function resolveConnectionToken(input: {
  connection: {
    accessTokenSecret: string | null;
    expiresAt: Date | string | null;
    id: string;
    metadata: unknown;
    provider: ConnectionProvider;
    refreshTokenSecret: string | null;
  };
  sql: postgres.Sql;
}): Promise<string> {
  if (input.connection.provider === 'github') {
    if (input.connection.accessTokenSecret && !isExpired(input.connection.expiresAt)) {
      return decryptConnectionSecretValue(input.connection.accessTokenSecret);
    }
    return createGitHubInstallationAccessToken(input.connection.metadata);
  }

  if (input.connection.accessTokenSecret && !isExpired(input.connection.expiresAt)) {
    return decryptConnectionSecretValue(input.connection.accessTokenSecret);
  }
  if (!input.connection.refreshTokenSecret) {
    throw new Error('Google OAuth connection does not have a refresh token.');
  }

  const refreshToken = decryptConnectionSecretValue(input.connection.refreshTokenSecret);
  const refreshed = await refreshGoogleAccessToken(refreshToken);
  if (!refreshed.access_token) {
    throw new Error('Google OAuth token refresh did not return an access token.');
  }
  const expiresAt =
    typeof refreshed.expires_in === 'number'
      ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
      : null;
  const accessTokenSecret = encryptConnectionSecretValue(refreshed.access_token);
  await input.sql`
    UPDATE public.oauth_connections
    SET
      access_token_secret = ${accessTokenSecret},
      expires_at = ${expiresAt},
      updated_at = now()
    WHERE id = ${input.connection.id}
  `;
  return refreshed.access_token;
}

async function refreshGoogleAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for Google token refresh.',
    );
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Google OAuth token refresh failed with status ${response.status}.`);
  }
  return (await response.json()) as GoogleTokenResponse;
}

async function createGitHubInstallationAccessToken(metadataValue: unknown): Promise<string> {
  const metadata = isRecord(metadataValue) ? metadataValue : {};
  const installationId = metadata.installationId;
  if (typeof installationId !== 'string' && typeof installationId !== 'number') {
    throw new Error('GitHub OAuth connection does not have an installation id.');
  }
  const appId = typeof metadata.githubAppId === 'string' ? metadata.githubAppId : null;
  const privateKey = githubAppPrivateKey(metadata);
  if (!appId || !privateKey) {
    throw new Error(
      'GitHub App ID and private key are required for GitHub collection. Configure GitHub App in project Settings or pass --connection-id for a configured GitHub connection.',
    );
  }
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(
      String(installationId),
    )}/access_tokens`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${createGitHubAppJwt(appId, privateKey)}`,
        'user-agent': 'pufu-lens-github-app/0.1',
        'x-github-api-version': '2022-11-28',
      },
      method: 'POST',
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub installation token request failed with status ${response.status}.`);
  }
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string') {
    throw new Error('GitHub installation token response did not include a token.');
  }
  return body.token;
}

function createGitHubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({
    exp: now + 9 * 60,
    iat: now - 60,
    iss: appId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey, 'base64url');
  return `${signingInput}.${signature}`;
}

function githubAppPrivateKey(metadata: Record<string, unknown>): string | null {
  const encrypted = metadata.githubAppPrivateKeyEncrypted;
  if (isEncryptedConnectionSecret(encrypted)) {
    return decryptConnectionSecret(encrypted);
  }
  return null;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function isExpired(value: Date | string | null): boolean {
  if (!value) {
    return false;
  }
  const expiresAt = new Date(value);
  return Number.isNaN(expiresAt.getTime()) ? false : expiresAt.getTime() <= Date.now() + 60_000;
}

function encryptConnectionSecretValue(value: string): string {
  return `${ENCRYPTED_CONNECTION_SECRET_PREFIX}${Buffer.from(
    JSON.stringify(encryptConnectionSecret(value)),
    'utf8',
  ).toString('base64url')}`;
}

function encryptConnectionSecret(value: string): EncryptedConnectionSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', connectionSecretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    alg: 'aes-256-gcm',
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptConnectionSecretValue(secretValue: string): string {
  if (!secretValue.startsWith(ENCRYPTED_CONNECTION_SECRET_PREFIX)) {
    throw new Error('OAuth connection token must be encrypted before collection.');
  }
  const encoded = secretValue.slice(ENCRYPTED_CONNECTION_SECRET_PREFIX.length);
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  if (!isEncryptedConnectionSecret(parsed)) {
    throw new Error('OAuth connection secret payload is invalid.');
  }
  return decryptConnectionSecret(parsed);
}

function decryptConnectionSecret(value: EncryptedConnectionSecret): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    connectionSecretKey(),
    Buffer.from(value.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function isEncryptedConnectionSecret(value: unknown): value is EncryptedConnectionSecret {
  return (
    isRecord(value) &&
    value.alg === 'aes-256-gcm' &&
    typeof value.ciphertext === 'string' &&
    typeof value.iv === 'string' &&
    typeof value.tag === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function connectionSecretKey(): Buffer {
  const value = process.env.CONNECTION_SECRET_KEY ?? process.env.AUTH_SECRET;
  if (!value) {
    throw new Error('CONNECTION_SECRET_KEY is required to decrypt OAuth connection tokens.');
  }
  return createHash('sha256').update(value).digest();
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
