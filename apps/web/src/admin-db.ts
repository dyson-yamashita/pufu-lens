import type postgres from 'postgres';
import {
  availabilityFromConnections,
  type ConnectionProvider,
  type DataSourceSummary,
  fallbackProjects,
  fallbackPublicProjects,
  notConnectedProjectConnections,
  type ParserProfileStatus,
  type ParserProfileSummary,
  type ProjectConnectionStatus,
  type ProjectConnectionSummary,
  type ProjectSourceAvailability,
  type ProjectSummary,
  type ProjectVisibility,
  type PublicProjectReportSummary,
  type PublicProjectSummary,
  type SourceStatus,
  type SourceType,
} from './admin-data';
import { getOptionalAdminSql } from './admin-sql';
import { isFixtureFallbackEnabled } from './runtime-guards';

type ProjectRow = {
  description: string | null;
  failed_count: number | string | bigint;
  held_count: number | string | bigint;
  id: string;
  last_indexed: Date | string | null;
  member_count: number | string | bigint;
  name: string;
  queue_count: number | string | bigint;
  raw_count: number | string | bigint;
  slug: string;
  visibility: ProjectVisibility;
};

type PublicProjectReportRow = {
  description: string | null;
  name: string;
  published_at: Date | string | null;
  report_id: string | null;
  report_summary: string | null;
  report_title: string | null;
  slug: string;
};

type MutablePublicProjectSummary = Omit<PublicProjectSummary, 'reports'> & {
  reports: PublicProjectReportSummary[];
};

export type AppMemberRole = 'admin' | 'member';

export type AppMemberSummary = {
  readonly createdAt: string;
  readonly email: string;
  readonly id: string;
  readonly name: string | null;
  readonly role: AppMemberRole;
};

export type ProjectMemberRole = 'admin' | 'member';

export type ProjectMemberSummary = {
  readonly createdAt: string;
  readonly email: string;
  readonly id: string;
  readonly name: string | null;
  readonly projectRole: ProjectMemberRole;
  readonly removable: boolean;
  readonly role: AppMemberRole;
};

export type ProjectMembershipSummary = {
  readonly canManageMembers: boolean;
  readonly members: readonly ProjectMemberSummary[];
  readonly project: ProjectSummary;
  readonly users: readonly AppMemberSummary[];
};

export type GlobalMemberDirectory = {
  readonly canManageMembers: boolean;
  readonly members: readonly AppMemberSummary[];
};

type AppMemberRow = {
  created_at: Date | string;
  email: string;
  id: string;
  name: string | null;
  role: AppMemberRole;
};

type ProjectMemberRow = AppMemberRow & {
  membership_created_at: Date | string | null;
  project_role: ProjectMemberRole;
  removable: boolean;
};

type DataSourceRow = {
  config: unknown;
  failed_count: number | string | bigint;
  held_count: number | string | bigint;
  id: string;
  last_checked_at: Date | string | null;
  last_indexed: Date | string | null;
  name: string;
  queue_count: number | string | bigint;
  raw_count: number | string | bigint;
  project_id: string;
  source_type: SourceType;
};

type ParserProfileRow = {
  active_version: string | null;
  held_queue_count: number | string | bigint;
  id: string;
  name: string;
  review_status: string | null;
  review_validation_report_uri: string | null;
  review_version: string | null;
  review_version_id: string | null;
  project_id: string;
  source_type: SourceType;
};

type AdminConfig = Record<string, unknown> & {
  readonly folderId?: unknown;
  readonly query?: unknown;
  readonly repositories?: unknown;
  readonly source?: unknown;
  readonly urls?: unknown;
};

export async function listAdminProjects(): Promise<readonly ProjectSummary[]> {
  return withOptionalSql<readonly ProjectSummary[]>(async (sql) => {
    const rows = (await sql`
      SELECT
        p.id::text AS id,
        p.slug,
        p.name,
        p.description,
        p.visibility,
        (SELECT count(*)::int FROM public.project_members pm WHERE pm.project_id = p.id) AS member_count,
        (SELECT count(*)::int FROM public.raw_documents rd WHERE rd.project_id = p.id) AS raw_count,
        (SELECT count(*)::int FROM public.ingestion_queue iq WHERE iq.project_id = p.id) AS queue_count,
        (
          SELECT count(*)::int
          FROM public.raw_documents rd
          WHERE rd.project_id = p.id AND rd.ingest_status = 'failed'
        ) AS failed_count,
        (
          SELECT count(*)::int
          FROM public.raw_documents rd
          WHERE rd.project_id = p.id AND rd.ingest_status = 'held'
        ) AS held_count,
        (SELECT max(rd.indexed_at) FROM public.raw_documents rd WHERE rd.project_id = p.id) AS last_indexed
      FROM public.projects p
      ORDER BY p.slug
    `) as ProjectRow[];

    const projectIds = rows.map((row) => row.id);
    const [dataSourcesByProject, parserProfilesByProject] = await Promise.all([
      listDataSourcesByProject(sql, projectIds),
      listParserProfilesByProject(sql, projectIds),
    ]);
    const projects = rows.map((row) =>
      projectFromRow(
        row,
        dataSourcesByProject.get(row.id) ?? [],
        parserProfilesByProject.get(row.id) ?? [],
      ),
    );
    return projects;
  }, fallbackProjects);
}

export async function listMemberProjects(userId: string): Promise<readonly ProjectSummary[]> {
  return withOptionalSql(async (sql) => {
    const rows = (await sql`
      SELECT
        p.id::text AS id,
        p.slug,
        p.name,
        p.description,
        p.visibility,
        (SELECT count(*)::int FROM public.project_members pm WHERE pm.project_id = p.id) AS member_count,
        (SELECT count(*)::int FROM public.raw_documents rd WHERE rd.project_id = p.id) AS raw_count,
        (SELECT count(*)::int FROM public.ingestion_queue iq WHERE iq.project_id = p.id) AS queue_count,
        (
          SELECT count(*)::int
          FROM public.raw_documents rd
          WHERE rd.project_id = p.id AND rd.ingest_status = 'failed'
        ) AS failed_count,
        (
          SELECT count(*)::int
          FROM public.raw_documents rd
          WHERE rd.project_id = p.id AND rd.ingest_status = 'held'
        ) AS held_count,
        (SELECT max(rd.indexed_at) FROM public.raw_documents rd WHERE rd.project_id = p.id) AS last_indexed
      FROM public.projects p
      JOIN public.users app_user
        ON app_user.id = ${userId}
      LEFT JOIN public.project_members current_member
        ON current_member.project_id = p.id
       AND current_member.user_id = app_user.id
      WHERE app_user.role = 'admin'
         OR current_member.user_id IS NOT NULL
      ORDER BY p.slug
    `) as ProjectRow[];

    const projectIds = rows.map((row) => row.id);
    const [dataSourcesByProject, parserProfilesByProject] = await Promise.all([
      listDataSourcesByProject(sql, projectIds),
      listParserProfilesByProject(sql, projectIds),
    ]);
    return rows.map((row) =>
      projectFromRow(
        row,
        dataSourcesByProject.get(row.id) ?? [],
        parserProfilesByProject.get(row.id) ?? [],
      ),
    );
  }, []);
}

export async function listPublicProjects(): Promise<readonly PublicProjectSummary[]> {
  return withOptionalSql(async (sql) => {
    const rows = (await sql`
      SELECT
        p.slug,
        p.name,
        p.description,
        r.id::text AS report_id,
        r.title AS report_title,
        r.summary AS report_summary,
        r.created_at AS published_at
      FROM public.projects p
      JOIN LATERAL (
        SELECT id, title, summary, created_at
        FROM public.reports
        WHERE project_id = p.id
          AND is_public = true
        ORDER BY created_at DESC
        LIMIT 3
      ) r ON true
      WHERE p.visibility = 'public'
      ORDER BY p.slug, r.created_at DESC
    `) as PublicProjectReportRow[];
    return publicProjectsFromRows(rows);
  }, publicProjectsFallback());
}

export async function listVisiblePublicProjects(): Promise<readonly PublicProjectSummary[]> {
  return withOptionalSql(async (sql) => {
    const rows = (await sql`
      SELECT
        p.slug,
        p.name,
        p.description,
        r.id::text AS report_id,
        r.title AS report_title,
        r.summary AS report_summary,
        r.created_at AS published_at
      FROM public.projects p
      LEFT JOIN LATERAL (
        SELECT id, title, summary, created_at
        FROM public.reports
        WHERE project_id = p.id
          AND is_public = true
        ORDER BY created_at DESC
        LIMIT 3
      ) r ON true
      WHERE p.visibility = 'public'
      ORDER BY p.slug, r.created_at DESC NULLS LAST
    `) as PublicProjectReportRow[];
    return publicProjectsFromRows(rows);
  }, publicProjectsFallback());
}

export async function getVisiblePublicProject(
  slug: string,
): Promise<PublicProjectSummary | undefined> {
  return withOptionalSql(
    async (sql) => {
      const rows = (await sql`
      SELECT
        p.slug,
        p.name,
        p.description,
        r.id::text AS report_id,
        r.title AS report_title,
        r.summary AS report_summary,
        r.created_at AS published_at
      FROM public.projects p
      LEFT JOIN LATERAL (
        SELECT id, title, summary, created_at
        FROM public.reports
        WHERE project_id = p.id
          AND is_public = true
        ORDER BY created_at DESC
        LIMIT 3
      ) r ON true
      WHERE p.visibility = 'public'
        AND p.slug = ${slug}
      ORDER BY r.created_at DESC NULLS LAST
    `) as PublicProjectReportRow[];
      return publicProjectsFromRows(rows)[0];
    },
    publicProjectsFallback().find((project) => project.slug === slug),
  );
}

export async function listAppMembersForUser(userId: string): Promise<GlobalMemberDirectory> {
  return withOptionalSql(
    async (sql) => {
      const accessRows = (await sql`
      SELECT role
      FROM public.users
      WHERE id = ${userId}
        AND role IN ('admin', 'member')
    `) as Array<{ role: AppMemberRole }>;
      const access = accessRows[0];
      if (!access) {
        throw new Error('Members access is required.');
      }
      const rows = (await sql`
      SELECT id::text, email, name, role, created_at
      FROM public.users
      ORDER BY email
    `) as AppMemberRow[];
      return {
        canManageMembers: access.role === 'admin',
        members: rows.map(memberFromRow),
      };
    },
    { canManageMembers: false, members: [] },
  );
}

export async function isGlobalAdminUser(userId: string): Promise<boolean> {
  return withOptionalSql(async (sql) => {
    const rows = (await sql`
      SELECT id::text
      FROM public.users
      WHERE id = ${userId}
        AND role = 'admin'
    `) as Array<{ id: string }>;
    return Boolean(rows[0]);
  }, false);
}

export async function getAppUserRole(userId: string): Promise<AppMemberRole | undefined> {
  return withOptionalSql(async (sql) => {
    const rows = (await sql`
      SELECT role
      FROM public.users
      WHERE id = ${userId}
        AND role IN ('admin', 'member')
    `) as Array<{ role: AppMemberRole }>;
    return rows[0]?.role;
  }, undefined);
}

export async function canManageProject(slug: string, userId: string): Promise<boolean> {
  return withOptionalSql(async (sql) => {
    const rows = (await sql`
      SELECT true AS can_manage
      FROM public.projects p
      JOIN public.users app_user
        ON app_user.id = ${userId}
      LEFT JOIN public.project_members pm
        ON pm.project_id = p.id
       AND pm.user_id = app_user.id
      WHERE p.slug = ${slug}
        AND (app_user.role = 'admin' OR pm.role = 'admin')
      LIMIT 1
    `) as Array<{ can_manage: boolean }>;
    return Boolean(rows[0]);
  }, false);
}

export async function getProjectMembership(
  slug: string,
  userId: string,
): Promise<ProjectMembershipSummary> {
  const sql = getOptionalAdminSql();
  if (!sql) {
    throw new Error('DATABASE_URL is required for project members.');
  }

  const accessRows = (await sql`
    SELECT
      p.id::text AS project_id,
      app_user.role AS app_role,
      pm.role AS project_role
    FROM public.projects p
    JOIN public.users app_user
      ON app_user.id = ${userId}
    LEFT JOIN public.project_members pm
      ON pm.project_id = p.id
     AND pm.user_id = app_user.id
    WHERE p.slug = ${slug}
      AND (app_user.role = 'admin' OR pm.user_id IS NOT NULL)
  `) as Array<{
    app_role: AppMemberRole;
    project_id: string;
    project_role: ProjectMemberRole | null;
  }>;
  const access = accessRows[0];
  if (!access) {
    throw new Error(`Member access denied for project slug: ${slug}`);
  }

  const project = await getAdminProject(slug);
  const [memberRows, userRows] = await Promise.all([
    sql`
      WITH project_member_rows AS (
        SELECT
          users.id,
          users.email,
          users.name,
          users.role,
          project_members.role AS project_role,
          project_members.created_at AS membership_created_at,
          project_members.role = 'member' AND users.role <> 'admin' AS removable
        FROM public.project_members
        JOIN public.users
          ON users.id = project_members.user_id
        WHERE project_members.project_id = ${access.project_id}
      ),
      global_admin_rows AS (
        SELECT
          users.id,
          users.email,
          users.name,
          users.role,
          'admin'::text AS project_role,
          users.created_at AS membership_created_at,
          false AS removable
        FROM public.users
        WHERE users.role = 'admin'
          AND NOT EXISTS (
            SELECT 1
            FROM public.project_members
            WHERE project_members.project_id = ${access.project_id}
              AND project_members.user_id = users.id
          )
      )
      SELECT
        id::text,
        email,
        name,
        role,
        project_role,
        membership_created_at,
        removable
      FROM (
        SELECT * FROM project_member_rows
        UNION ALL
        SELECT * FROM global_admin_rows
      ) members
      ORDER BY email
    ` as Promise<ProjectMemberRow[]>,
    access.app_role === 'admin' || access.project_role === 'admin'
      ? (sql`
          SELECT id::text, email, name, role, created_at
          FROM public.users
          ORDER BY email
        ` as Promise<AppMemberRow[]>)
      : Promise.resolve([]),
  ]);

  return {
    canManageMembers: access.app_role === 'admin' || access.project_role === 'admin',
    members: memberRows.map(projectMemberFromRow),
    project,
    users: userRows.map(memberFromRow),
  };
}

type OAuthConnectionRow = {
  account_email: string | null;
  account_login: string | null;
  expires_at: Date | string | null;
  metadata: unknown;
  provider: ConnectionProvider;
  scopes: string[] | null;
  updated_at: Date | string | null;
};

export async function listProjectConnections(
  projectSlug: string,
): Promise<readonly ProjectConnectionSummary[]> {
  return withOptionalSql(async (sql) => {
    const rows = (await sql`
      SELECT
        oc.provider,
        oc.account_email,
        oc.account_login,
        oc.scopes,
        oc.metadata,
        oc.expires_at,
        oc.updated_at
      FROM public.oauth_connections oc
      JOIN public.projects p ON p.id = oc.project_id
      WHERE p.slug = ${projectSlug}
    `) as OAuthConnectionRow[];
    return projectConnectionsFromRows(rows);
  }, notConnectedProjectConnections());
}

export async function listProjectConnectionsForProjectId(
  sql: postgres.Sql,
  projectId: string,
): Promise<readonly ProjectConnectionSummary[]> {
  const rows = (await sql`
    SELECT
      oc.provider,
      oc.account_email,
      oc.account_login,
      oc.scopes,
      oc.metadata,
      oc.expires_at,
      oc.updated_at
    FROM public.oauth_connections oc
    WHERE oc.project_id = ${projectId}
  `) as OAuthConnectionRow[];
  return projectConnectionsFromRows(rows);
}

export async function getProjectSourceAvailability(
  projectSlug: string,
): Promise<ProjectSourceAvailability> {
  const connections = await listProjectConnections(projectSlug);
  return availabilityFromConnections(connections);
}

export async function getAdminProject(slug: string): Promise<ProjectSummary> {
  const sql = getOptionalAdminSql();
  if (!sql) {
    return getFallbackProject(slug);
  }

  try {
    const rows = (await sql`
      SELECT
        p.id::text AS id,
        p.slug,
        p.name,
        p.description,
        p.visibility,
        (SELECT count(*)::int FROM public.project_members pm WHERE pm.project_id = p.id) AS member_count,
        (SELECT count(*)::int FROM public.raw_documents rd WHERE rd.project_id = p.id) AS raw_count,
        (SELECT count(*)::int FROM public.ingestion_queue iq WHERE iq.project_id = p.id) AS queue_count,
        (
          SELECT count(*)::int
          FROM public.raw_documents rd
          WHERE rd.project_id = p.id AND rd.ingest_status = 'failed'
        ) AS failed_count,
        (
          SELECT count(*)::int
          FROM public.raw_documents rd
          WHERE rd.project_id = p.id AND rd.ingest_status = 'held'
        ) AS held_count,
        (SELECT max(rd.indexed_at) FROM public.raw_documents rd WHERE rd.project_id = p.id) AS last_indexed
      FROM public.projects p
      WHERE p.slug = ${slug}
    `) as ProjectRow[];
    const row = rows[0];
    if (!row) {
      throw new Error(`Unknown project slug: ${slug}`);
    }
    const [dataSources, parserProfiles] = await Promise.all([
      listDataSources(sql, row.id),
      listParserProfiles(sql, row.id),
    ]);
    return projectFromRow(row, dataSources, parserProfiles);
  } catch (error) {
    if (!isFixtureFallbackEnabled()) {
      throw error;
    }
    const fallback = fallbackProjects.find((candidate) => candidate.slug === slug);
    if (fallback) {
      console.warn(error instanceof Error ? error.message : String(error));
      return fallback;
    }
    throw error;
  }
}

function memberFromRow(row: AppMemberRow): AppMemberSummary {
  return {
    createdAt: formatDate(row.created_at),
    email: row.email,
    id: row.id,
    name: row.name,
    role: row.role,
  };
}

function projectMemberFromRow(row: ProjectMemberRow): ProjectMemberSummary {
  return {
    createdAt: formatDate(row.membership_created_at),
    email: row.email,
    id: row.id,
    name: row.name,
    projectRole: row.project_role,
    removable: row.removable,
    role: row.role,
  };
}

export function getSourceTypeCounts(project: ProjectSummary): Record<SourceType, number> {
  return project.dataSources.reduce<Record<SourceType, number>>(
    (counts, source) => {
      counts[source.sourceType] += 1;
      return counts;
    },
    { drive: 0, github: 0, gmail: 0, web: 0 },
  );
}

async function listDataSourcesByProject(
  sql: postgres.Sql,
  projectIds: readonly string[],
): Promise<ReadonlyMap<string, readonly DataSourceSummary[]>> {
  if (projectIds.length === 0) {
    return new Map();
  }

  const rows = (await sql`
    SELECT
      ds.project_id::text AS project_id,
      ds.id::text AS id,
      ds.name,
      ds.source_type,
      ds.config,
      ds.last_checked_at,
      (
        SELECT count(*)::int
        FROM public.raw_document_data_sources rdds
        WHERE rdds.data_source_id = ds.id
      ) AS raw_count,
      (
        SELECT count(*)::int
        FROM public.ingestion_queue iq
        WHERE iq.data_source_id = ds.id
      ) AS queue_count,
      (
        SELECT count(*)::int
        FROM public.ingestion_queue iq
        WHERE iq.data_source_id = ds.id AND iq.status = 'failed'
      ) AS failed_count,
      (
        SELECT count(*)::int
        FROM public.ingestion_queue iq
        WHERE iq.data_source_id = ds.id AND iq.status = 'held'
      ) AS held_count,
      (
        SELECT max(rd.indexed_at)
        FROM public.raw_document_data_sources rdds
        JOIN public.raw_documents rd ON rd.id = rdds.raw_document_id
        WHERE rdds.data_source_id = ds.id
      ) AS last_indexed
    FROM public.data_sources ds
    WHERE ds.enabled = true
      AND ds.project_id IN ${sql(projectIds)}
    ORDER BY ds.source_type, ds.name
  `) as DataSourceRow[];

  return groupRowsByProject(rows, dataSourceFromRow);
}

function dataSourceFromRow(row: DataSourceRow): DataSourceSummary {
  const failedCount = toNumber(row.failed_count);
  const heldCount = toNumber(row.held_count);
  const queueCount = toNumber(row.queue_count);
  return {
    configSummary: summarizeConfig(row.source_type, row.config),
    failedCount,
    heldCount,
    id: row.id,
    lastChecked: formatDate(row.last_checked_at),
    lastIndexed: formatDate(row.last_indexed),
    name: row.name,
    queueCount,
    rawCount: toNumber(row.raw_count),
    editableScope: editableScopeFromConfig(row.source_type, row.config),
    scope: summarizeScope(row.source_type, row.config),
    sourceType: row.source_type,
    status: statusFromCounts({ failedCount, heldCount, queueCount }),
  };
}

async function listDataSources(
  sql: postgres.Sql,
  projectId: string,
): Promise<readonly DataSourceSummary[]> {
  const rows = (await sql`
    SELECT
      ds.project_id::text AS project_id,
      ds.id::text AS id,
      ds.name,
      ds.source_type,
      ds.config,
      ds.last_checked_at,
      (
        SELECT count(*)::int
        FROM public.raw_document_data_sources rdds
        WHERE rdds.data_source_id = ds.id
      ) AS raw_count,
      (
        SELECT count(*)::int
        FROM public.ingestion_queue iq
        WHERE iq.data_source_id = ds.id
      ) AS queue_count,
      (
        SELECT count(*)::int
        FROM public.ingestion_queue iq
        WHERE iq.data_source_id = ds.id AND iq.status = 'failed'
      ) AS failed_count,
      (
        SELECT count(*)::int
        FROM public.ingestion_queue iq
        WHERE iq.data_source_id = ds.id AND iq.status = 'held'
      ) AS held_count,
      (
        SELECT max(rd.indexed_at)
        FROM public.raw_document_data_sources rdds
        JOIN public.raw_documents rd ON rd.id = rdds.raw_document_id
        WHERE rdds.data_source_id = ds.id
      ) AS last_indexed
    FROM public.data_sources ds
    WHERE ds.project_id = ${projectId}
      AND ds.enabled = true
    ORDER BY ds.source_type, ds.name
  `) as DataSourceRow[];

  return rows.map(dataSourceFromRow);
}

async function listParserProfilesByProject(
  sql: postgres.Sql,
  projectIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ParserProfileSummary[]>> {
  if (projectIds.length === 0) {
    return new Map();
  }

  const rows = (await sql`
    SELECT
      pp.project_id::text AS project_id,
      pp.id::text AS id,
      pp.name,
      pp.source_type,
      active_versions.version AS active_version,
      review_versions.id::text AS review_version_id,
      review_versions.version AS review_version,
      review_versions.status AS review_status,
      review_versions.validation_report_uri AS review_validation_report_uri,
      (
        SELECT count(*)::int
        FROM public.ingestion_queue iq
        WHERE iq.parser_profile_id = pp.id AND iq.status = 'held'
      ) AS held_queue_count
    FROM public.parser_profiles pp
    LEFT JOIN public.parser_versions AS active_versions
      ON active_versions.id = pp.active_version_id
    LEFT JOIN public.parser_versions AS review_versions
      ON review_versions.parser_profile_id = pp.id
      AND review_versions.status IN ('draft', 'review_requested')
    WHERE pp.project_id IN ${sql(projectIds)}
    ORDER BY pp.source_type, pp.name, review_versions.created_at DESC NULLS LAST
  `) as ParserProfileRow[];

  return groupParserProfileRowsByProject(rows);
}

async function listParserProfiles(
  sql: postgres.Sql,
  projectId: string,
): Promise<readonly ParserProfileSummary[]> {
  const rows = (await sql`
    SELECT
      pp.project_id::text AS project_id,
      pp.id::text AS id,
      pp.name,
      pp.source_type,
      active_versions.version AS active_version,
      review_versions.id::text AS review_version_id,
      review_versions.version AS review_version,
      review_versions.status AS review_status,
      review_versions.validation_report_uri AS review_validation_report_uri,
      (
        SELECT count(*)::int
        FROM public.ingestion_queue iq
        WHERE iq.parser_profile_id = pp.id AND iq.status = 'held'
      ) AS held_queue_count
    FROM public.parser_profiles pp
    LEFT JOIN public.parser_versions AS active_versions
      ON active_versions.id = pp.active_version_id
    LEFT JOIN public.parser_versions AS review_versions
      ON review_versions.parser_profile_id = pp.id
      AND review_versions.status IN ('draft', 'review_requested')
    WHERE pp.project_id = ${projectId}
    ORDER BY pp.source_type, pp.name, review_versions.created_at DESC NULLS LAST
  `) as ParserProfileRow[];

  return parserProfilesFromRows(rows);
}

function groupParserProfileRowsByProject(
  rows: readonly ParserProfileRow[],
): ReadonlyMap<string, readonly ParserProfileSummary[]> {
  const rowsByProject = new Map<string, ParserProfileRow[]>();
  for (const row of rows) {
    const projectRows = rowsByProject.get(row.project_id);
    if (projectRows) {
      projectRows.push(row);
      continue;
    }
    rowsByProject.set(row.project_id, [row]);
  }

  const profilesByProject = new Map<string, readonly ParserProfileSummary[]>();
  for (const [projectId, projectRows] of rowsByProject) {
    profilesByProject.set(projectId, parserProfilesFromRows(projectRows));
  }
  return profilesByProject;
}

function parserProfilesFromRows(
  rows: readonly ParserProfileRow[],
): readonly ParserProfileSummary[] {
  const seen = new Set<string>();
  const profiles: ParserProfileSummary[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    profiles.push({
      activeVersion: row.active_version ?? 'none',
      draftVersion: row.review_version ?? 'none',
      heldQueueCount: toNumber(row.held_queue_count),
      id: row.id,
      name: row.name,
      reviewVersionId: row.review_version_id ?? undefined,
      sourceType: row.source_type,
      status: normalizeParserStatus(row.review_status),
      validationReport: row.review_validation_report_uri ?? 'validation report なし',
    });
  }
  return profiles;
}

function groupRowsByProject<TRow extends { readonly project_id: string }, TValue>(
  rows: readonly TRow[],
  mapper: (row: TRow) => TValue,
): ReadonlyMap<string, readonly TValue[]> {
  const valuesByProject = new Map<string, TValue[]>();
  for (const row of rows) {
    const values = valuesByProject.get(row.project_id);
    if (values) {
      values.push(mapper(row));
      continue;
    }
    valuesByProject.set(row.project_id, [mapper(row)]);
  }
  return valuesByProject;
}

function projectFromRow(
  row: ProjectRow,
  dataSources: readonly DataSourceSummary[],
  parserProfiles: readonly ParserProfileSummary[],
): ProjectSummary {
  const failedCount = toNumber(row.failed_count);
  const heldCount = toNumber(row.held_count);
  const queueCount = toNumber(row.queue_count);
  return {
    dataSources,
    description: row.description,
    failedCount,
    heldCount,
    lastIndexed: formatDate(row.last_indexed),
    memberCount: toNumber(row.member_count),
    name: row.name,
    parserProfiles,
    queueCount,
    rawCount: toNumber(row.raw_count),
    slug: row.slug,
    status: failedCount > 0 || heldCount > 0 ? 'attention' : 'active',
    visibility: row.visibility,
  };
}

function publicProjectsFromRows(
  rows: readonly PublicProjectReportRow[],
): readonly PublicProjectSummary[] {
  const projects = new Map<string, MutablePublicProjectSummary>();
  for (const row of rows) {
    const existing = projects.get(row.slug);
    const project = existing ?? {
      description: row.description ?? '',
      name: row.name,
      reports: [],
      slug: row.slug,
    };
    if (row.report_id && row.report_title) {
      project.reports.push({
        id: row.report_id,
        publishedAt: formatDate(row.published_at),
        summary: row.report_summary ?? '',
        title: row.report_title,
      });
    }
    projects.set(row.slug, project);
  }
  return Array.from(projects.values());
}

function publicProjectsFallback(): readonly PublicProjectSummary[] {
  return isFixtureFallbackEnabled() ? fallbackPublicProjects : [];
}

async function withOptionalSql<T>(
  callback: (sql: postgres.Sql) => Promise<T>,
  fallback: T,
): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    if (!isFixtureFallbackEnabled()) {
      throw new Error('DATABASE_URL is required.');
    }
    return fallback;
  }

  const sql = getOptionalAdminSql();
  if (!sql) {
    if (!isFixtureFallbackEnabled()) {
      throw new Error('DATABASE_URL is required.');
    }
    return fallback;
  }
  try {
    return await callback(sql);
  } catch (error) {
    if (!isFixtureFallbackEnabled()) {
      throw error;
    }
    console.warn(error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

function statusFromCounts(input: {
  readonly failedCount: number;
  readonly heldCount: number;
  readonly queueCount: number;
}): SourceStatus {
  if (input.failedCount > 0) {
    return 'failed';
  }
  if (input.heldCount > 0) {
    return 'held';
  }
  if (input.queueCount > 0) {
    return 'syncing';
  }
  return 'healthy';
}

function normalizeParserStatus(status: string | null): ParserProfileStatus {
  if (status === 'review_requested' || status === 'draft' || status === 'approved') {
    return status;
  }
  if (status === 'retired') {
    return 'rejected';
  }
  return 'approved';
}

function summarizeScope(sourceType: SourceType, config: unknown): string {
  const object: AdminConfig = isRecord(config) ? config : {};
  if (sourceType === 'web' && Array.isArray(object.urls)) {
    return object.urls.map(String).join(', ');
  }
  if (sourceType === 'github' && Array.isArray(object.repositories)) {
    return object.repositories.map(String).join(', ');
  }
  if (sourceType === 'drive' && typeof object.folderId === 'string') {
    return `folder: ${object.folderId}`;
  }
  if (sourceType === 'gmail' && typeof object.query === 'string') {
    return object.query;
  }
  return typeof object.source === 'string' ? object.source : 'configured';
}

function editableScopeFromConfig(sourceType: SourceType, config: unknown): string {
  const object: AdminConfig = isRecord(config) ? config : {};
  if (sourceType === 'web' && Array.isArray(object.urls)) {
    return object.urls.map(String).join('\n');
  }
  if (sourceType === 'github' && Array.isArray(object.repositories)) {
    return object.repositories.map(String).join('\n');
  }
  if (sourceType === 'drive' && typeof object.folderId === 'string') {
    return object.folderId;
  }
  if (sourceType === 'gmail' && typeof object.query === 'string') {
    return object.query;
  }
  return '';
}

function summarizeConfig(sourceType: SourceType, config: unknown): string {
  const object: AdminConfig = isRecord(config) ? config : {};
  if (sourceType === 'web' && Array.isArray(object.urls)) {
    return `URL ${object.urls.length} 件`;
  }
  if (typeof object.source === 'string') {
    return object.source;
  }
  return `${sourceType} config`;
}

function formatDate(value: Date | string | null): string {
  if (!value) {
    return 'not yet';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'invalid date';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: number | string | bigint): number {
  return Number(value);
}

function getFallbackProject(slug: string): ProjectSummary {
  const project = fallbackProjects.find((candidate) => candidate.slug === slug);
  if (!project) {
    throw new Error(`Unknown project slug: ${slug}`);
  }
  return project;
}

function projectConnectionsFromRows(
  rows: readonly OAuthConnectionRow[],
): readonly ProjectConnectionSummary[] {
  const byProvider = new Map(rows.map((row) => [row.provider, connectionFromRow(row)]));
  return (['google', 'github'] as const).map(
    (provider) => byProvider.get(provider) ?? notConnectedConnection(provider),
  );
}

function connectionFromRow(row: OAuthConnectionRow): ProjectConnectionSummary {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const metadataLabels = metadataLabelsFromRecord(metadata);
  const scopes = Array.isArray(row.scopes) ? row.scopes.map(String) : [];
  const status = connectionStatusFromRow(row, scopes, metadata);
  return {
    accountLabel: accountLabelFromRow(row),
    configuration: connectionConfigurationFromMetadata(row.provider, metadata),
    grantedScopes: scopes,
    metadataLabels,
    permissionsSummary: permissionsSummaryFromMetadata(row.provider, metadata),
    provider: row.provider,
    scopesSummary: scopesSummaryFromScopes(row.provider, scopes),
    status,
    updatedAt: formatDate(row.updated_at),
  };
}

function notConnectedConnection(provider: ConnectionProvider): ProjectConnectionSummary {
  const connection = notConnectedProjectConnections().find(
    (candidate) => candidate.provider === provider,
  );
  if (!connection) {
    throw new Error(`Unsupported connection provider: ${provider}`);
  }
  return connection;
}

function connectionStatusFromRow(
  row: OAuthConnectionRow,
  scopes: readonly string[],
  metadata: Record<string, unknown>,
): ProjectConnectionStatus {
  if (metadata.connectionError === true || metadata.status === 'error') {
    return 'error';
  }
  if (metadata.scopeMissing === true || metadata.status === 'scope_missing') {
    return 'scope_missing';
  }
  if (row.expires_at) {
    const expiresAt = new Date(row.expires_at);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
      return 'expired';
    }
  }
  if (scopes.length === 0 && row.provider === 'google') {
    return 'scope_missing';
  }
  if (
    row.provider === 'github' &&
    typeof metadata.installationId !== 'string' &&
    typeof metadata.installationId !== 'number'
  ) {
    return 'not_connected';
  }
  return 'connected';
}

function connectionConfigurationFromMetadata(
  provider: ConnectionProvider,
  metadata: Record<string, unknown>,
): ProjectConnectionSummary['configuration'] {
  if (provider !== 'github') {
    return {};
  }
  return {
    githubAppId: typeof metadata.githubAppId === 'string' ? metadata.githubAppId : undefined,
    githubAppSlug: typeof metadata.githubAppSlug === 'string' ? metadata.githubAppSlug : undefined,
    githubPrivateKeyConfigured: metadata.githubPrivateKeyConfigured === true,
  };
}

function accountLabelFromRow(row: OAuthConnectionRow): string | null {
  if (row.provider === 'github') {
    return row.account_login ?? row.account_email;
  }
  return row.account_email ?? row.account_login;
}

function scopesSummaryFromScopes(provider: ConnectionProvider, scopes: readonly string[]): string {
  if (scopes.length === 0) {
    return provider === 'google' ? 'Gmail / Drive scopes pending' : 'Repository read pending';
  }
  return scopes.join(', ');
}

function permissionsSummaryFromMetadata(
  provider: ConnectionProvider,
  metadata: Record<string, unknown>,
): string {
  if (provider === 'github') {
    const installationId = metadata.installationId;
    const repositories = metadata.repositories;
    if (typeof installationId === 'string' || typeof installationId === 'number') {
      const repoSummary = Array.isArray(repositories)
        ? `${repositories.length} repositories selected`
        : 'Installation active';
      return `GitHub App installation ${installationId}: ${repoSummary}`;
    }
    return 'GitHub App installation not configured';
  }
  const enabledServices = [
    metadata.gmailEnabled === true ? 'Gmail' : null,
    metadata.driveEnabled === true ? 'Drive' : null,
  ].filter((value): value is string => Boolean(value));
  if (enabledServices.length > 0) {
    return enabledServices.join(' + ');
  }
  return 'Google workspace access';
}

function metadataLabelsFromRecord(metadata: Record<string, unknown>): readonly string[] {
  const labels: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (key.toLowerCase().includes('token') || key.toLowerCase().includes('secret')) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      labels.push(`${key}: ${String(value)}`);
    }
  }
  return labels;
}
