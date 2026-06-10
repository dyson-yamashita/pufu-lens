'use server';

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { revalidatePath } from 'next/cache';
import type postgres from 'postgres';
import {
  BUILT_IN_PARSER_ARTIFACT_HASH,
  type CollectionRepository,
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
import {
  deriveProjectIdentifiers,
  validateProjectSlug,
} from '../../../packages/project-tenancy/src/project-tenancy.ts';
import { LocalFsObjectStorage } from '../../../packages/storage/src/local-fs.ts';
import type { ProjectVisibility, SourceType } from './admin-data';
import type { AppMemberRole } from './admin-db';
import { getRequiredAdminSql } from './admin-sql';
import { requireSessionUserId } from './auth-session';
import { hashPassword } from './password-auth';
import {
  createExtractiveReportProvider,
  createGeminiReportProvider,
  createPostgresReportRepository,
  createReportStorageFromEnv,
  type ReportGenerationProvider,
  reportNowFromEnv,
  runGenerateReport,
  writePublicProjectManifest,
} from './report';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export async function createProject(formData: FormData): Promise<void> {
  const name = requireFormValue(formData, 'name').trim();
  if (!name) {
    throw new Error('name is required.');
  }
  const slug = validateProjectSlug(requireFormValue(formData, 'slug').trim());
  const description = formData.get('description')?.toString().trim() || null;
  const visibility = requireProjectVisibility(
    formData.get('visibility')?.toString().trim() || 'private',
  );
  const identifiers = deriveProjectIdentifiers(slug);

  await withSql(async (sql) => {
    const adminUserId = await requireGlobalAdmin(sql);
    await sql.begin(async (tx) => {
      await tx`LOAD 'age'`;
      await tx`SET search_path = ag_catalog, "$user", public`;

      const existing = (await tx`
        SELECT slug FROM public.projects WHERE slug = ${slug}
      `) as Array<{ slug: string }>;
      if (existing.length > 0) {
        throw new Error(`Project slug already exists: ${slug}`);
      }

      const projects = (await tx`
        INSERT INTO public.projects (slug, name, description, graph_name, storage_prefix, visibility)
        VALUES (
          ${slug},
          ${name},
          ${description},
          ${identifiers.graphName},
          ${identifiers.storagePrefix},
          ${visibility}
        )
        RETURNING id::text
      `) as Array<{ id: string }>;
      const project = projects[0];
      if (!project) {
        throw new Error('Project creation failed.');
      }

      await tx`
        INSERT INTO public.project_members (project_id, user_id, role)
        VALUES (${project.id}, ${adminUserId}, 'admin')
        ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'admin'
      `;

      await tx`
        SELECT create_graph(${identifiers.graphName})
        WHERE NOT EXISTS (
          SELECT 1 FROM ag_catalog.ag_graph WHERE name = ${identifiers.graphName}
        )
      `;
    });
  });

  await ensureProjectStoragePrefixes(slug);
  await writePublicProjectVisibilityManifest(slug, visibility);
  revalidatePath('/projects');
}

export async function updateProjectVisibility(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const visibility = requireProjectVisibility(requireFormValue(formData, 'visibility'));

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    if (visibility === 'private') {
      await writePublicProjectVisibilityManifest(projectSlug, visibility);
      await updateProjectVisibilityRow(sql, project.id, visibility);
      return;
    }

    await updateProjectVisibilityRow(sql, project.id, visibility);
    try {
      await writePublicProjectVisibilityManifest(projectSlug, visibility);
    } catch (error) {
      await updateProjectVisibilityRow(sql, project.id, project.visibility);
      throw error;
    }
  });

  revalidateProject(projectSlug);
}

export async function createMember(formData: FormData): Promise<void> {
  const email = normalizeEmail(requireFormValue(formData, 'email'));
  const name = formData.get('name')?.toString().trim() || null;
  const role = requireAppMemberRole(requireFormValue(formData, 'role'));
  const password = formData.get('password')?.toString() ?? '';
  const passwordConfirm = formData.get('passwordConfirm')?.toString() ?? '';

  if (!isValidEmail(email)) {
    throw new Error('Invalid email address.');
  }
  validateOptionalPassword(password, passwordConfirm);

  await withSql(async (sql) => {
    await requireGlobalAdmin(sql);
    await sql.begin(async (tx) => {
      const rows = (await tx`
        INSERT INTO public.users (email, name, role)
        VALUES (${email}, ${name}, ${role})
        RETURNING id::text
      `) as Array<{ id: string }>;
      const user = rows[0];
      if (!user) {
        throw new Error('Member creation failed.');
      }
      if (password) {
        const passwordHash = await hashPassword(password);
        await tx`
          INSERT INTO public.auth_password_credentials (user_id, password_hash)
          VALUES (${user.id}, ${passwordHash})
          ON CONFLICT (user_id)
          DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
        `;
      }
    });
  });

  revalidatePath('/members');
}

export async function updateMember(formData: FormData): Promise<void> {
  const userId = requireFormValue(formData, 'userId');
  const name = formData.get('name')?.toString().trim() || null;
  const role = requireAppMemberRole(requireFormValue(formData, 'role'));
  const password = formData.get('password')?.toString() ?? '';
  const passwordConfirm = formData.get('passwordConfirm')?.toString() ?? '';

  validateOptionalPassword(password, passwordConfirm);

  await withSql(async (sql) => {
    await requireGlobalAdmin(sql);
    await sql.begin(async (tx) => {
      if (role === 'member') {
        await assertAdminRemainsAfterRoleChange(tx, userId);
      }
      await tx`
        UPDATE public.users
        SET name = ${name},
            role = ${role}
        WHERE id = ${userId}
      `;
      if (password) {
        const passwordHash = await hashPassword(password);
        await tx`
          INSERT INTO public.auth_password_credentials (user_id, password_hash)
          VALUES (${userId}, ${passwordHash})
          ON CONFLICT (user_id)
          DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
        `;
      }
    });
  });

  revalidatePath('/members');
  revalidatePath('/projects');
}

export async function addProjectMember(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const userId = requireFormValue(formData, 'userId');

  await withSql(async (sql) => {
    const project = await requireProjectMemberManager(sql, projectSlug);
    await sql`
      INSERT INTO public.project_members (project_id, user_id, role)
      VALUES (${project.id}, ${userId}, 'member')
      ON CONFLICT (project_id, user_id)
      DO UPDATE SET role = 'member'
    `;
  });

  revalidatePath(`/projects/${projectSlug}/members`);
  revalidatePath('/projects');
}

export async function removeProjectMember(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const userId = requireFormValue(formData, 'userId');

  await withSql(async (sql) => {
    const project = await requireProjectMemberManager(sql, projectSlug);
    await sql`
      DELETE FROM public.project_members
      USING public.users
      WHERE project_members.project_id = ${project.id}
        AND project_members.user_id = ${userId}
        AND users.id = project_members.user_id
        AND users.role <> 'admin'
        AND project_members.role = 'member'
    `;
  });

  revalidatePath(`/projects/${projectSlug}/members`);
  revalidatePath('/projects');
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

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await sql.begin(async (tx) => {
      const dataSources = (await tx`
        INSERT INTO public.data_sources (project_id, owner_user_id, source_type, name, config)
        VALUES (
          ${project.id},
          ${project.adminUserId},
          ${sourceType},
          ${name},
          ${tx.json(config as postgres.JSONValue)}
        )
        RETURNING id::text
      `) as Array<{ id: string }>;
      const dataSource = dataSources[0];
      if (!dataSource) {
        throw new Error('Data source creation failed.');
      }
      await ensureDefaultParserProfile(tx, {
        approvedByUserId: project.adminUserId,
        dataSourceId: dataSource.id,
        projectId: project.id,
        sourceType,
      });
    });
  });

  revalidateProject(projectSlug);
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
    const rows = (await sql`
      SELECT id::text, source_type
      FROM public.data_sources
      WHERE id = ${dataSourceId}
        AND project_id = ${project.id}
        AND enabled = true
    `) as Array<{ id: string; source_type: SourceType }>;
    const dataSource = rows[0];
    if (!dataSource) {
      throw new Error('Data source not found in project.');
    }
    const config = buildDataSourceConfig(dataSource.source_type, scope);
    await sql`
      UPDATE public.data_sources
      SET name = ${name},
          config = ${sql.json(config as postgres.JSONValue)},
          updated_at = now()
      WHERE id = ${dataSource.id}
        AND project_id = ${project.id}
    `;
  });

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
    const rows = (await sql`
      SELECT id::text, source_type
      FROM public.data_sources
      WHERE id = ${dataSourceId}
        AND project_id = ${project.id}
        AND enabled = true
    `) as Array<{ id: string; source_type: SourceType }>;
    const dataSource = rows[0];
    if (!dataSource) {
      throw new Error('Data source not found in project.');
    }
    if (dataSource.source_type !== 'web') {
      throw new Error(`Collect from admin UI is not supported for ${dataSource.source_type} yet.`);
    }
    await collectWebUrlSource({
      projectSlug,
      repository: new AdminCollectionRepository(sql, dataSourceId),
      storage: createCollectionStorageFromEnv(),
    });
  });
  revalidateProject(projectSlug);
}

export async function ingestDataSource(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const dataSourceId = requireFormValue(formData, 'dataSourceId');
  let storageRoot: string | undefined;
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    const rows = (await sql`
      SELECT
        ds.id::text,
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
        AND ds.project_id = ${project.id}
        AND ds.enabled = true
    `) as Array<{ id: string; source_type: SourceType; storage_uri: string | null }>;
    const dataSource = rows[0];
    if (!dataSource) {
      throw new Error('Data source not found in project.');
    }
    if (dataSource.source_type !== 'web') {
      throw new Error(`Ingest from admin UI is not supported for ${dataSource.source_type} yet.`);
    }
    storageRoot = storageRootFromObjectUri(dataSource.storage_uri, projectSlug);
  });
  await runIngestWorkflow({ dataSourceId, projectSlug, sourceType: 'web', storageRoot });
  revalidateProject(projectSlug);
}

export async function generatePrivateReport(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const period = requireReportPeriod(formData);
  await withSql(async (sql) => {
    await requireAdminProject(sql, projectSlug);
    await runGenerateReport({
      options: {
        generatedBy: 'admin-ui',
        now: reportNowFromEnv(process.env),
        period,
        provider: createReportProvider(),
        repository: createPostgresReportRepository(sql),
        storage: createReportStorageFromEnv(),
      },
      projectSlug,
    });
  });
  revalidateProject(projectSlug);
}

export async function approveParserVersion(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const parserProfileId = requireFormValue(formData, 'parserProfileId');
  const parserVersionId = requireFormValue(formData, 'parserVersionId');

  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await sql.begin(async (tx) => {
      const parserVersion = await lookupProjectParserVersion(
        tx,
        project.id,
        parserProfileId,
        parserVersionId,
      );
      requireParserVersionReviewable(parserVersion, 'approve');

      await tx`
        UPDATE public.parser_versions
        SET status = 'approved',
            approved_by_user_id = ${project.adminUserId},
            approved_at = now(),
            updated_at = now()
        WHERE id = ${parserVersion.id}
      `;
      await tx`
        UPDATE public.parser_profiles
        SET active_version_id = ${parserVersion.id},
            updated_at = now()
        WHERE id = ${parserProfileId}
          AND project_id = ${project.id}
      `;
      await tx`
        UPDATE public.ingestion_queue
        SET status = 'pending',
            hold_reason = null,
            updated_at = now()
        WHERE project_id = ${project.id}
          AND parser_profile_id = ${parserProfileId}
          AND status = 'held'
      `;
      await tx`
        UPDATE public.raw_documents
        SET ingest_status = 'fetched',
            hold_reason = null,
            updated_at = now()
        WHERE project_id = ${project.id}
          AND parser_profile_id = ${parserProfileId}
          AND ingest_status = 'held'
      `;
    });
  });
  revalidateProject(projectSlug);
}

export async function rejectParserVersion(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const parserVersionId = requireFormValue(formData, 'parserVersionId');
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await sql.begin(async (tx) => {
      const parserVersion = await lookupProjectParserVersion(
        tx,
        project.id,
        undefined,
        parserVersionId,
      );
      requireParserVersionReviewable(parserVersion, 'reject');
      await tx`
        UPDATE public.parser_versions
        SET status = 'retired',
            updated_at = now()
        WHERE id = ${parserVersion.id}
      `;
    });
  });
  revalidateProject(projectSlug);
}

async function withSql<T>(callback: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  return callback(getRequiredAdminSql());
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
        ${sql.json({ managedBy: 'apps/web/src/admin-actions.ts' } as postgres.JSONValue)}
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
    const rows = (await this.sql`
      SELECT id::text AS id, slug
      FROM public.projects
      WHERE slug = ${slug}
    `) as ProjectRecord[];
    return rows[0];
  }

  async findDataSources(projectId: string, sourceType?: SourceType): Promise<DataSourceRecord[]> {
    if (sourceType !== 'web') {
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
        AND id = ${this.dataSourceId}
    `) as DataSourceRecord[];
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
        source_id AS "sourceId",
        source_type AS "sourceType"
      FROM public.raw_documents
      WHERE project_id = ${input.projectId}
        AND source_type = ${input.sourceType}
        AND source_id = ${input.sourceId}
    `) as RawDocumentRecord[];
    return rows[0];
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
    `) as RawDocumentRecord[];
    const rawDocument = rows[0];
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

async function requireAdminProject(
  sql: postgres.Sql,
  projectSlug: string,
): Promise<{
  readonly adminUserId: string;
  readonly id: string;
  readonly slug: string;
  readonly visibility: ProjectVisibility;
}> {
  const adminUserId = await requireAdminUserId();
  const rows = (await sql`
    SELECT
      projects.id::text AS id,
      projects.slug,
      COALESCE(projects.visibility, 'private') AS visibility,
      users.id::text AS admin_user_id
    FROM public.projects
    JOIN public.users ON users.id = ${adminUserId}
    LEFT JOIN public.project_members
      ON project_members.project_id = projects.id
     AND project_members.user_id = users.id
    WHERE projects.slug = ${projectSlug}
      AND (users.role = 'admin' OR project_members.role = 'admin')
  `) as Array<{
    admin_user_id: string;
    id: string;
    slug: string;
    visibility: ProjectVisibility;
  }>;
  const project = rows[0];
  if (!project) {
    throw new Error(`Admin access denied for project slug: ${projectSlug}`);
  }
  return {
    adminUserId: project.admin_user_id,
    id: project.id,
    slug: project.slug,
    visibility: project.visibility,
  };
}

async function requireAdminUserId(): Promise<string> {
  const sessionUserId = await requireSessionUserId();
  if (sessionUserId) {
    return sessionUserId;
  }
  throw new Error('Authentication is required for admin actions.');
}

function requireReportPeriod(formData: FormData): { readonly end: string; readonly start: string } {
  const start = requireIsoDate(requireFormValue(formData, 'periodStart'), 'periodStart');
  const end = requireIsoDate(requireFormValue(formData, 'periodEnd'), 'periodEnd');
  if (start > end) {
    throw new Error('periodStart must be before or equal to periodEnd.');
  }
  return { end, start };
}

function requireIsoDate(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`${fieldName} must be YYYY-MM-DD.`);
  }
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new Error(`${fieldName} must be a valid date.`);
  }
  return trimmed;
}

async function requireGlobalAdmin(sql: postgres.Sql | postgres.TransactionSql): Promise<string> {
  const userId = await requireSessionUserId();
  const rows = (await sql`
    SELECT id::text
    FROM public.users
    WHERE id = ${userId}
      AND role = 'admin'
  `) as Array<{ id: string }>;
  const user = rows[0];
  if (!user) {
    throw new Error('Admin access is required.');
  }
  return user.id;
}

async function runIngestWorkflow(input: {
  readonly dataSourceId: string;
  readonly projectSlug: string;
  readonly sourceType: SourceType;
  readonly storageRoot?: string;
}): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Admin UI ingest is only available in local development. Use the ingest worker or CLI in production.',
    );
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
          resolve(repoRoot, 'infra/volumes/pufu-lens-data'),
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

async function assertAdminRemainsAfterRoleChange(
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string,
): Promise<void> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS admin_count
    FROM public.users
    WHERE role = 'admin'
      AND id <> ${userId}
  `) as Array<{ admin_count: number | string }>;
  const adminCount = Number(rows[0]?.admin_count ?? 0);
  if (adminCount < 1) {
    throw new Error('At least one admin account is required.');
  }
}

async function requireProjectMemberManager(
  sql: postgres.Sql | postgres.TransactionSql,
  projectSlug: string,
): Promise<{
  readonly id: string;
  readonly slug: string;
}> {
  const userId = await requireSessionUserId();
  const rows = (await sql`
    SELECT projects.id::text AS id, projects.slug
    FROM public.projects
    JOIN public.users
      ON users.id = ${userId}
    LEFT JOIN public.project_members
      ON project_members.project_id = projects.id
     AND project_members.user_id = users.id
    WHERE projects.slug = ${projectSlug}
      AND (users.role = 'admin' OR project_members.role = 'admin')
  `) as Array<{ id: string; slug: string }>;
  const project = rows[0];
  if (!project) {
    throw new Error(`Member management denied for project slug: ${projectSlug}`);
  }
  return project;
}

function requireSourceType(value: string): SourceType {
  if (value === 'drive' || value === 'github' || value === 'gmail' || value === 'web') {
    return value;
  }
  throw new Error(`Unsupported source type: ${value}`);
}

function requireProjectVisibility(value: string): ProjectVisibility {
  if (value === 'private' || value === 'public') {
    return value;
  }
  throw new Error(`Unsupported project visibility: ${value}`);
}

function requireAppMemberRole(value: string): AppMemberRole {
  if (value === 'admin' || value === 'member') {
    return value;
  }
  throw new Error(`Unsupported member role: ${value}`);
}

function validateOptionalPassword(password: string, passwordConfirm: string): void {
  if (!password && !passwordConfirm) {
    return;
  }
  if (password !== passwordConfirm) {
    throw new Error('password confirmation does not match.');
  }
  if (password.length < 8) {
    throw new Error('password must be at least 8 characters.');
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function updateProjectVisibilityRow(
  sql: postgres.Sql,
  projectId: string,
  visibility: ProjectVisibility,
): Promise<void> {
  await sql`
    UPDATE public.projects
    SET visibility = ${visibility},
        updated_at = now()
    WHERE id = ${projectId}
  `;
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

function createReportProvider(): ReportGenerationProvider {
  const fallbackProvider = createExtractiveReportProvider();
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_CHAT_MODEL) {
    const geminiProvider = createGeminiReportProvider({
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_CHAT_MODEL,
    });
    return {
      async generate(input) {
        try {
          return await geminiProvider.generate(input);
        } catch (error) {
          console.warn(
            'Gemini report generation failed; falling back to extractive provider.',
            error instanceof Error ? error.message : String(error),
          );
          return fallbackProvider.generate(input);
        }
      },
    };
  }
  return fallbackProvider;
}

function createCollectionStorageFromEnv(): LocalFsObjectStorage {
  const driver = process.env.STORAGE_DRIVER ?? process.env.OBJECT_STORAGE_DRIVER ?? 'local';
  if (driver !== 'local') {
    throw new Error(`Unsupported object storage driver for collection: ${driver}`);
  }
  const root = process.env.STORAGE_ROOT ?? process.env.LOCAL_STORAGE_ROOT;
  if (!root) {
    throw new Error('STORAGE_ROOT or LOCAL_STORAGE_ROOT is required for collection.');
  }
  return new LocalFsObjectStorage(root);
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

async function ensureProjectStoragePrefixes(projectSlug: string): Promise<void> {
  const storageRoot = process.env.STORAGE_ROOT ?? process.env.LOCAL_STORAGE_ROOT;
  if (!storageRoot) {
    return;
  }
  await new LocalFsObjectStorage(storageRoot).ensureProjectPrefixes(projectSlug);
}

async function writePublicProjectVisibilityManifest(
  projectSlug: string,
  visibility: ProjectVisibility,
): Promise<void> {
  try {
    await writePublicProjectManifest({
      projectSlug,
      storage: createReportStorageFromEnv(),
      visibility,
    });
  } catch (error) {
    if (error instanceof Error && /STORAGE_ROOT|LOCAL_STORAGE_ROOT/.test(error.message)) {
      return;
    }
    throw error;
  }
}

async function lookupProjectParserVersion(
  sql: SqlExecutor,
  projectId: string,
  parserProfileId: string | undefined,
  parserVersionId: string,
): Promise<{ readonly id: string; readonly status: string }> {
  const parserProfileFilter = parserProfileId
    ? sql`AND parser_profiles.id = ${parserProfileId}`
    : sql``;
  const rows = (await sql`
    SELECT parser_versions.id::text AS id, parser_versions.status
    FROM public.parser_versions
    JOIN public.parser_profiles ON parser_profiles.id = parser_versions.parser_profile_id
    WHERE parser_profiles.project_id = ${projectId}
      ${parserProfileFilter}
      AND parser_versions.id = ${parserVersionId}
  `) as Array<{ id: string; status: string }>;
  const parserVersion = rows[0];
  if (!parserVersion) {
    throw new Error('Parser version not found in project.');
  }
  return parserVersion;
}

function requireParserVersionReviewable(
  parserVersion: { readonly id: string; readonly status: string },
  action: 'approve' | 'reject',
): void {
  if (parserVersion.status === 'draft' || parserVersion.status === 'review_requested') {
    return;
  }
  throw new Error(
    `Cannot ${action} parser version ${parserVersion.id} from status ${parserVersion.status}.`,
  );
}

function requireFormValue(formData: FormData, key: string): string {
  const value = formData.get(key)?.toString();
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function revalidateProject(projectSlug: string): void {
  revalidatePath('/projects');
  revalidatePath(`/projects/${projectSlug}/admin/data-sources`);
  revalidatePath(`/projects/${projectSlug}/admin/ingestion`);
  revalidatePath(`/projects/${projectSlug}/admin/parser-profiles`);
  revalidatePath(`/projects/${projectSlug}/reports`);
}
