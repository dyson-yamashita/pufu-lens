import type postgres from 'postgres';
import {
  buildActorMergeCandidates,
  type ProjectActorAliasSummary,
  type ProjectActorDirectory,
  type ProjectActorSummary,
} from './admin-actors';
import {
  availabilityFromConnections,
  type ConnectionProvider,
  DATA_SOURCE_SNIPPET_MAX_LENGTH,
  type DataSourceContentPreview,
  type DataSourceDocumentPreviewRow,
  type DataSourceQueuePreviewRow,
  type DataSourceSummary,
  fallbackProjects,
  fallbackPublicProjects,
  getFallbackDataSourceContentPreview,
  notConnectedProjectConnections,
  type ParserProfileStatus,
  type ParserProfileSummary,
  type ProjectConnectionStatus,
  type ProjectConnectionSummary,
  type ProjectSourceAvailability,
  type ProjectSummary,
  type PublicProjectReportSummary,
  type PublicProjectSummary,
  type SourceStatus,
  type SourceType,
  truncateSnippet,
} from './admin-data';
import {
  type AdminDbActorAliasRow,
  type AdminDbActorRow,
  type AdminDbAppMemberRow,
  type AdminDbDataSourcePreviewDocumentRow,
  type AdminDbDataSourcePreviewQueueRow,
  type AdminDbDataSourceRow,
  type AdminDbOAuthConnectionRow,
  type AdminDbParserProfileRow,
  type AdminDbProjectMemberRow,
  type AdminDbProjectRow,
  type AdminDbPublicProjectReportRow,
  parseAdminDbActorAliasRow,
  parseAdminDbActorRow,
  parseAdminDbAppMemberRow,
  parseAdminDbDataSourcePreviewDocumentRow,
  parseAdminDbDataSourcePreviewQueueRow,
  parseAdminDbDataSourcePreviewScopeRow,
  parseAdminDbDataSourcePreviewSummaryRow,
  parseAdminDbDataSourceRow,
  parseAdminDbIdRow,
  parseAdminDbOAuthConnectionRow,
  parseAdminDbParserProfileRow,
  parseAdminDbProjectMemberRow,
  parseAdminDbProjectRow,
  parseAdminDbPublicProjectReportRow,
  parseAppMemberRoleRow,
  parseCanManageProjectRow,
} from './admin-db-guards';
import { getOptionalAdminSql } from './admin-sql';
import { lookupProjectMemberAccess } from './authz';
import { isFixtureFallbackEnabled } from './runtime-guards';

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

type AdminConfig = Record<string, unknown> & {
  readonly folderId?: unknown;
  readonly query?: unknown;
  readonly repositories?: unknown;
  readonly source?: unknown;
  readonly urls?: unknown;
};

export async function listAdminProjects(): Promise<readonly ProjectSummary[]> {
  return withOptionalSql<readonly ProjectSummary[]>(async (sql) => {
    const rawRows = (await sql`
      SELECT
        p.id::text AS id,
        p.slug,
        p.name,
        p.description,
        p.visibility,
        (SELECT count(*)::int FROM public.project_members pm WHERE pm.project_id = p.id) AS member_count,
        (SELECT count(*)::int FROM public.raw_documents rd WHERE rd.project_id = p.id) AS raw_count,
        (
          SELECT count(*)::int
          FROM public.raw_documents rd
          WHERE rd.project_id = p.id AND rd.ingest_status = 'indexed'
        ) AS ingested_count,
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
    `) as readonly unknown[];

    const rows = rawRows.map(parseAdminDbProjectRow);
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
    const rawRows = (await sql`
      SELECT
        p.id::text AS id,
        p.slug,
        p.name,
        p.description,
        p.visibility,
        (SELECT count(*)::int FROM public.project_members pm WHERE pm.project_id = p.id) AS member_count,
        (SELECT count(*)::int FROM public.raw_documents rd WHERE rd.project_id = p.id) AS raw_count,
        (
          SELECT count(*)::int
          FROM public.raw_documents rd
          WHERE rd.project_id = p.id AND rd.ingest_status = 'indexed'
        ) AS ingested_count,
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
    `) as readonly unknown[];

    const rows = rawRows.map(parseAdminDbProjectRow);
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
    const rawRows = (await sql`
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
    `) as readonly unknown[];
    return publicProjectsFromRows(rawRows.map(parseAdminDbPublicProjectReportRow));
  }, publicProjectsFallback());
}

export async function listVisiblePublicProjects(): Promise<readonly PublicProjectSummary[]> {
  return withOptionalSql(async (sql) => {
    const rawRows = (await sql`
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
    `) as readonly unknown[];
    return publicProjectsFromRows(rawRows.map(parseAdminDbPublicProjectReportRow));
  }, publicProjectsFallback());
}

export async function getVisiblePublicProject(
  slug: string,
): Promise<PublicProjectSummary | undefined> {
  return withOptionalSql(
    async (sql) => {
      const rawRows = (await sql`
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
    `) as readonly unknown[];
      return publicProjectsFromRows(rawRows.map(parseAdminDbPublicProjectReportRow))[0];
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
    `) as readonly unknown[];
      const accessRole = accessRows[0] ? parseAppMemberRoleRow(accessRows[0]) : undefined;
      if (!accessRole) {
        throw new Error('Members access is required.');
      }
      const rows = (await sql`
      SELECT id::text, email, name, role, created_at
      FROM public.users
      ORDER BY email
    `) as readonly unknown[];
      return {
        canManageMembers: accessRole === 'admin',
        members: rows.map((row) => memberFromRow(parseAdminDbAppMemberRow(row))),
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
    `) as readonly unknown[];
    if (!rows[0]) {
      return false;
    }
    parseAdminDbIdRow(rows[0], 'global admin user');
    return true;
  }, false);
}

export async function getAppUserRole(userId: string): Promise<AppMemberRole | undefined> {
  return withOptionalSql(async (sql) => {
    const rows = (await sql`
      SELECT role
      FROM public.users
      WHERE id = ${userId}
        AND role IN ('admin', 'member')
    `) as readonly unknown[];
    return rows[0] ? parseAppMemberRoleRow(rows[0]) : undefined;
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
    `) as readonly unknown[];
    return rows[0] ? parseCanManageProjectRow(rows[0]) : false;
  }, false);
}

export async function getProjectMembership(
  slug: string,
  userId: string,
): Promise<ProjectMembershipSummary> {
  const sql = getOptionalAdminSql();
  if (!sql) {
    if (isFixtureFallbackEnabled()) {
      return fallbackProjectMembership(slug, userId);
    }
    throw new Error('DATABASE_URL is required for project members.');
  }

  const access = await lookupProjectMemberAccess(sql, { projectSlug: slug, userId });
  if (!access) {
    throw new Error(`Member access denied for project slug: ${slug}`);
  }
  const canManageMembers = access.appRole === 'admin' || access.projectRole === 'admin';

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
        WHERE project_members.project_id = ${access.id}
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
            WHERE project_members.project_id = ${access.id}
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
    ` as Promise<readonly unknown[]>,
    canManageMembers
      ? (sql`
          SELECT id::text, email, name, role, created_at
          FROM public.users
          ORDER BY email
        ` as Promise<readonly unknown[]>)
      : Promise.resolve([] as readonly unknown[]),
  ]);

  return {
    canManageMembers,
    members: memberRows.map((row) => projectMemberFromRow(parseAdminDbProjectMemberRow(row))),
    project,
    users: userRows.map((row) => memberFromRow(parseAdminDbAppMemberRow(row))),
  };
}

function fallbackProjectMembership(slug: string, userId: string): ProjectMembershipSummary {
  const project = getFallbackProject(slug);
  const member: ProjectMemberSummary = {
    createdAt: '',
    email: `${userId}@example.test`,
    id: userId,
    name: userId,
    projectRole: 'member',
    removable: false,
    role: 'member',
  };
  return {
    canManageMembers: false,
    members: [member],
    project,
    users: [],
  };
}

export async function listProjectConnections(
  projectSlug: string,
): Promise<readonly ProjectConnectionSummary[]> {
  return withOptionalSql(async (sql) => {
    const rawRows = (await sql`
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
    `) as readonly unknown[];
    return projectConnectionsFromRows(rawRows.map(parseAdminDbOAuthConnectionRow));
  }, notConnectedProjectConnections());
}

export async function listProjectConnectionsForProjectId(
  sql: postgres.Sql,
  projectId: string,
): Promise<readonly ProjectConnectionSummary[]> {
  const rawRows = (await sql`
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
  `) as readonly unknown[];
  return projectConnectionsFromRows(rawRows.map(parseAdminDbOAuthConnectionRow));
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
    const rawRows = (await sql`
      SELECT
        p.id::text AS id,
        p.slug,
        p.name,
        p.description,
        p.visibility,
        (SELECT count(*)::int FROM public.project_members pm WHERE pm.project_id = p.id) AS member_count,
        (SELECT count(*)::int FROM public.raw_documents rd WHERE rd.project_id = p.id) AS raw_count,
        (
          SELECT count(*)::int
          FROM public.raw_documents rd
          WHERE rd.project_id = p.id AND rd.ingest_status = 'indexed'
        ) AS ingested_count,
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
    `) as readonly unknown[];
    const row = rawRows[0] ? parseAdminDbProjectRow(rawRows[0]) : undefined;
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

export async function getProjectActorDirectory(
  projectSlug: string,
): Promise<ProjectActorDirectory> {
  return withOptionalSql(async (sql) => {
    const rawActorRows = (await sql`
      SELECT
        actors.id::text AS id,
        actors.actor_type,
        actors.display_name,
        actors.primary_email,
        actors.primary_login,
        actors.graph_node_id,
        actors.created_at,
        actors.updated_at
      FROM public.actors
      JOIN public.projects ON projects.id = actors.project_id
      WHERE projects.slug = ${projectSlug}
      ORDER BY lower(actors.display_name), actors.created_at
    `) as readonly unknown[];
    const actorRows = rawActorRows.map(parseAdminDbActorRow);

    if (actorRows.length === 0) {
      return { actors: [], mergeCandidates: [] };
    }

    const rawAliasRows = (await sql`
      SELECT
        actor_aliases.actor_id::text AS actor_id,
        actor_aliases.alias_type,
        actor_aliases.alias_value,
        actor_aliases.confidence,
        actor_aliases.source
      FROM public.actor_aliases
      JOIN public.actors ON actors.id = actor_aliases.actor_id
      JOIN public.projects ON projects.id = actors.project_id
      WHERE projects.slug = ${projectSlug}
      ORDER BY actor_aliases.alias_type, actor_aliases.alias_value
    `) as readonly unknown[];
    const aliasRows = rawAliasRows.map(parseAdminDbActorAliasRow);
    const aliasesByActor = groupAliasesByActor(aliasRows);
    const actors = actorRows.map((row) => actorFromRow(row, aliasesByActor.get(row.id) ?? []));

    return {
      actors,
      mergeCandidates: buildActorMergeCandidates(actors),
    };
  }, fallbackActorDirectory(projectSlug));
}

function groupAliasesByActor(
  rows: readonly AdminDbActorAliasRow[],
): ReadonlyMap<string, readonly ProjectActorAliasSummary[]> {
  const aliasesByActor = new Map<string, ProjectActorAliasSummary[]>();
  for (const row of rows) {
    const alias = aliasFromRow(row);
    const aliases = aliasesByActor.get(row.actor_id);
    if (aliases) {
      aliases.push(alias);
      continue;
    }
    aliasesByActor.set(row.actor_id, [alias]);
  }
  return aliasesByActor;
}

function actorFromRow(
  row: AdminDbActorRow,
  aliases: readonly ProjectActorAliasSummary[],
): ProjectActorSummary {
  const strongAliasCount = aliases.filter((alias) => alias.strength === 'strong').length;
  const weakAliasCount = aliases.length - strongAliasCount;
  return {
    actorType: row.actor_type,
    aliases,
    createdAt: formatDate(row.created_at),
    displayName: row.display_name,
    graphNodeId: row.graph_node_id,
    id: row.id,
    primaryEmail: row.primary_email ?? 'none',
    primaryLogin: row.primary_login ?? 'none',
    sourceTypes: sourceTypesFromAliases(aliases),
    strongAliasCount,
    updatedAt: formatDate(row.updated_at),
    weakAliasCount,
  };
}

function aliasFromRow(row: AdminDbActorAliasRow): ProjectActorAliasSummary {
  return {
    aliasType: row.alias_type,
    aliasValue: row.alias_value,
    confidence: Number(row.confidence),
    source: row.source ?? 'unknown',
    strength: isStrongActorAlias(row.alias_type) ? 'strong' : 'weak',
  };
}

function fallbackActorDirectory(projectSlug: string): ProjectActorDirectory {
  const actors = projectSlug === 'sample-a' ? sampleAActors() : [];
  return {
    actors,
    mergeCandidates: buildActorMergeCandidates(actors),
  };
}

function sampleAActors(): readonly ProjectActorSummary[] {
  return [
    sampleActor({
      aliases: [
        {
          aliasType: 'display_name',
          aliasValue: '前田考歩',
          confidence: 0.4,
          source: 'web:author',
          strength: 'weak',
        },
      ],
      displayName: '前田考歩',
      graphNodeId: 'actor:unresolved:https%3A%2F%2Fnote.com%2Fkodomonogatari:author:maeda',
      id: 'sample-a-actor-web-maeda',
      sourceTypes: ['web'],
      weakAliasCount: 1,
    }),
    sampleActor({
      aliases: [
        {
          aliasType: 'github_login',
          aliasValue: 'kodomonogatari',
          confidence: 1,
          source: 'github:author',
          strength: 'strong',
        },
      ],
      displayName: '前田考歩',
      graphNodeId: 'actor:github_login:kodomonogatari',
      id: 'sample-a-actor-github-maeda',
      primaryLogin: 'kodomonogatari',
      sourceTypes: ['github'],
      strongAliasCount: 1,
    }),
    sampleActor({
      aliases: [
        {
          aliasType: 'email',
          aliasValue: 'support@example.com',
          confidence: 1,
          source: 'gmail:sender',
          strength: 'strong',
        },
      ],
      displayName: 'Support Team',
      graphNodeId: 'actor:email:support%40example.com',
      id: 'sample-a-actor-support',
      primaryEmail: 'support@example.com',
      sourceTypes: ['gmail'],
      strongAliasCount: 1,
    }),
  ];
}

function sampleActor(
  actor: Pick<ProjectActorSummary, 'displayName' | 'graphNodeId' | 'id'> &
    Partial<ProjectActorSummary>,
): ProjectActorSummary {
  const aliases = actor.aliases ?? [];
  return {
    actorType: actor.actorType ?? 'person',
    aliases,
    createdAt: actor.createdAt ?? '2026-06-13 08:00',
    displayName: actor.displayName,
    graphNodeId: actor.graphNodeId,
    id: actor.id,
    primaryEmail: actor.primaryEmail ?? 'none',
    primaryLogin: actor.primaryLogin ?? 'none',
    sourceTypes: actor.sourceTypes ?? sourceTypesFromAliases(aliases),
    strongAliasCount:
      actor.strongAliasCount ?? aliases.filter((alias) => alias.strength === 'strong').length,
    updatedAt: actor.updatedAt ?? '2026-06-13 08:00',
    weakAliasCount:
      actor.weakAliasCount ?? aliases.filter((alias) => alias.strength === 'weak').length,
  };
}

function sourceTypesFromAliases(aliases: readonly ProjectActorAliasSummary[]): readonly string[] {
  const sourceTypes = new Set<string>();
  for (const alias of aliases) {
    const sourceType = alias.source.split(':')[0]?.trim();
    if (sourceType && sourceType !== 'unknown') {
      sourceTypes.add(sourceType);
    }
  }
  return Array.from(sourceTypes).sort();
}

function isStrongActorAlias(aliasType: string): boolean {
  return aliasType === 'email' || aliasType === 'github_login';
}

function memberFromRow(row: AdminDbAppMemberRow): AppMemberSummary {
  return {
    createdAt: formatDate(row.created_at),
    email: row.email,
    id: row.id,
    name: row.name,
    role: row.role,
  };
}

function projectMemberFromRow(row: AdminDbProjectMemberRow): ProjectMemberSummary {
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

  const rawRows = (await sql`
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
        FROM public.raw_document_data_sources rdds
        JOIN public.raw_documents rd ON rd.id = rdds.raw_document_id
        WHERE rdds.data_source_id = ds.id
          AND rd.ingest_status = 'indexed'
      ) AS ingested_count,
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
  `) as readonly unknown[];

  return groupRowsByProject(rawRows.map(parseAdminDbDataSourceRow), dataSourceFromRow);
}

function dataSourceFromRow(row: AdminDbDataSourceRow): DataSourceSummary {
  const failedCount = toNumber(row.failed_count);
  const heldCount = toNumber(row.held_count);
  const ingestedCount = toNumber(row.ingested_count);
  const queueCount = toNumber(row.queue_count);
  const rawCount = toNumber(row.raw_count);
  const lastChecked = formatDate(row.last_checked_at);
  const lastIndexed = formatDate(row.last_indexed);
  return {
    configSummary: summarizeConfig(row.source_type, row.config),
    failedCount,
    heldCount,
    id: row.id,
    ingestedCount,
    ingestHistory: [
      { label: 'Last collect', value: lastChecked },
      { label: 'Last indexed', value: lastIndexed },
      { label: 'Raw / Ingested', value: `${rawCount} / ${ingestedCount}` },
    ],
    lastChecked,
    lastIndexed,
    name: row.name,
    queueCount,
    rawCount,
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
  const rawRows = (await sql`
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
        FROM public.raw_document_data_sources rdds
        JOIN public.raw_documents rd ON rd.id = rdds.raw_document_id
        WHERE rdds.data_source_id = ds.id
          AND rd.ingest_status = 'indexed'
      ) AS ingested_count,
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
  `) as readonly unknown[];

  return rawRows.map((row) => dataSourceFromRow(parseAdminDbDataSourceRow(row)));
}

async function listParserProfilesByProject(
  sql: postgres.Sql,
  projectIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ParserProfileSummary[]>> {
  if (projectIds.length === 0) {
    return new Map();
  }

  const rawRows = (await sql`
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
  `) as readonly unknown[];

  return groupParserProfileRowsByProject(rawRows.map(parseAdminDbParserProfileRow));
}

async function listParserProfiles(
  sql: postgres.Sql,
  projectId: string,
): Promise<readonly ParserProfileSummary[]> {
  const rawRows = (await sql`
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
  `) as readonly unknown[];

  return parserProfilesFromRows(rawRows.map(parseAdminDbParserProfileRow));
}

function groupParserProfileRowsByProject(
  rows: readonly AdminDbParserProfileRow[],
): ReadonlyMap<string, readonly ParserProfileSummary[]> {
  const rowsByProject = new Map<string, AdminDbParserProfileRow[]>();
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
  rows: readonly AdminDbParserProfileRow[],
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
  row: AdminDbProjectRow,
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
    ingestedCount: toNumber(row.ingested_count),
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
  rows: readonly AdminDbPublicProjectReportRow[],
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
  rows: readonly AdminDbOAuthConnectionRow[],
): readonly ProjectConnectionSummary[] {
  const byProvider = new Map(rows.map((row) => [row.provider, connectionFromRow(row)]));
  return (['google', 'github'] as const).map(
    (provider) => byProvider.get(provider) ?? notConnectedConnection(provider),
  );
}

function connectionFromRow(row: AdminDbOAuthConnectionRow): ProjectConnectionSummary {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const metadataLabels = metadataLabelsFromRecord(metadata);
  const scopes = row.scopes ?? [];
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
  row: AdminDbOAuthConnectionRow,
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

function accountLabelFromRow(row: AdminDbOAuthConnectionRow): string | null {
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

const DATA_SOURCE_PREVIEW_DOCUMENT_LIMIT = 20;
const DATA_SOURCE_PREVIEW_QUEUE_LIMIT = 10;
const DATA_SOURCE_PREVIEW_ERROR_MAX_LENGTH = 120;

export async function getDataSourceContentPreview(
  projectSlug: string,
  dataSourceId: string,
): Promise<DataSourceContentPreview | null> {
  return withOptionalSql(async (sql) => {
    const rawScopeRows = (await sql`
      SELECT
        ds.id::text AS id,
        ds.project_id::text AS project_id,
        ds.last_checked_at
      FROM public.data_sources ds
      JOIN public.projects p ON p.id = ds.project_id
      WHERE p.slug = ${projectSlug}
        AND ds.id::text = ${dataSourceId}
        AND ds.enabled = true
      LIMIT 1
    `) as readonly unknown[];
    const scope = rawScopeRows[0]
      ? parseAdminDbDataSourcePreviewScopeRow(rawScopeRows[0])
      : undefined;
    if (!scope) {
      throw new Error(`Data source content preview target not found: ${dataSourceId}`);
    }

    const [rawSummaryRows, rawDocumentRows, rawQueueRows] = await Promise.all([
      sql`
        SELECT
          (
            SELECT count(*)::int
            FROM public.raw_document_data_sources rdds
            WHERE rdds.data_source_id = ${dataSourceId}
              AND rdds.project_id = ${scope.project_id}
          ) AS raw_count,
          (
            SELECT count(*)::int
            FROM public.raw_document_data_sources rdds
            JOIN public.raw_documents rd ON rd.id = rdds.raw_document_id
            WHERE rdds.data_source_id = ${dataSourceId}
              AND rdds.project_id = ${scope.project_id}
              AND rd.ingest_status = 'indexed'
          ) AS indexed_count,
          (
            SELECT count(*)::int
            FROM public.ingestion_queue iq
            WHERE iq.data_source_id = ${dataSourceId}
              AND iq.project_id = ${scope.project_id}
          ) AS queue_count,
          (
            SELECT count(*)::int
            FROM public.ingestion_queue iq
            WHERE iq.data_source_id = ${dataSourceId}
              AND iq.project_id = ${scope.project_id}
              AND iq.status = 'failed'
          ) AS failed_count,
          (
            SELECT count(*)::int
            FROM public.ingestion_queue iq
            WHERE iq.data_source_id = ${dataSourceId}
              AND iq.project_id = ${scope.project_id}
              AND iq.status = 'held'
          ) AS held_count,
          ds.last_checked_at,
          (
            SELECT max(rd.indexed_at)
            FROM public.raw_document_data_sources rdds
            JOIN public.raw_documents rd ON rd.id = rdds.raw_document_id
            WHERE rdds.data_source_id = ${dataSourceId}
              AND rdds.project_id = ${scope.project_id}
          ) AS last_indexed
        FROM public.data_sources ds
        WHERE ds.id = ${dataSourceId}
        LIMIT 1
      ` as Promise<readonly unknown[]>,
      sql`
        SELECT
          rd.id::text AS raw_document_id,
          d.id::text AS document_id,
          rd.source_id,
          COALESCE(d.title, rd.source_id) AS title,
          COALESCE(d.doc_type::text, rd.source_type) AS doc_type,
          rd.ingest_status,
          COALESCE(d.canonical_uri, rd.source_uri, '') AS canonical_uri,
          rd.fetched_at,
          rd.indexed_at,
          d.summary AS document_summary,
          (
            SELECT dc.content
            FROM public.document_chunks dc
            WHERE dc.document_id = d.id
            ORDER BY dc.chunk_index ASC
            LIMIT 1
          ) AS first_chunk_content
        FROM public.raw_document_data_sources rdds
        JOIN public.raw_documents rd ON rd.id = rdds.raw_document_id
        LEFT JOIN public.documents d ON d.raw_document_id = rd.id
        WHERE rdds.data_source_id = ${dataSourceId}
          AND rdds.project_id = ${scope.project_id}
        ORDER BY rd.fetched_at DESC
        LIMIT ${DATA_SOURCE_PREVIEW_DOCUMENT_LIMIT}
      ` as Promise<readonly unknown[]>,
      sql`
        SELECT
          iq.id::text AS id,
          iq.status,
          iq.attempts,
          iq.last_error,
          iq.updated_at
        FROM public.ingestion_queue iq
        WHERE iq.data_source_id = ${dataSourceId}
          AND iq.project_id = ${scope.project_id}
        ORDER BY iq.updated_at DESC
        LIMIT ${DATA_SOURCE_PREVIEW_QUEUE_LIMIT}
      ` as Promise<readonly unknown[]>,
    ]);
    const summaryRows = rawSummaryRows.map(parseAdminDbDataSourcePreviewSummaryRow);
    const documentRows = rawDocumentRows.map(parseAdminDbDataSourcePreviewDocumentRow);
    const queueRows = rawQueueRows.map(parseAdminDbDataSourcePreviewQueueRow);

    const summaryRow = summaryRows[0];
    if (!summaryRow) {
      return null;
    }

    return {
      documents: documentRows.map(documentPreviewFromRow),
      queue: queueRows.map(queuePreviewFromRow),
      summary: {
        failedCount: toNumber(summaryRow.failed_count),
        heldCount: toNumber(summaryRow.held_count),
        indexedCount: toNumber(summaryRow.indexed_count),
        lastChecked: formatDate(summaryRow.last_checked_at),
        lastIndexed: formatDate(summaryRow.last_indexed),
        queueCount: toNumber(summaryRow.queue_count),
        rawCount: toNumber(summaryRow.raw_count),
      },
    };
  }, getFallbackDataSourceContentPreview(dataSourceId));
}

function documentPreviewFromRow(
  row: AdminDbDataSourcePreviewDocumentRow,
): DataSourceDocumentPreviewRow {
  const snippetSource = row.document_summary ?? row.first_chunk_content ?? '';
  return {
    canonicalUri: row.canonical_uri ?? '',
    docType: row.doc_type ?? 'unknown',
    documentId: row.document_id ?? undefined,
    fetchedAt: formatDate(row.fetched_at),
    indexedAt: formatDate(row.indexed_at),
    ingestStatus: row.ingest_status,
    rawDocumentId: row.raw_document_id,
    snippet: snippetSource ? truncateSnippet(snippetSource, DATA_SOURCE_SNIPPET_MAX_LENGTH) : '',
    title: row.title ?? row.source_id,
  };
}

function queuePreviewFromRow(row: AdminDbDataSourcePreviewQueueRow): DataSourceQueuePreviewRow {
  return {
    attempts: toNumber(row.attempts),
    id: row.id,
    lastErrorSummary: row.last_error
      ? truncateSnippet(row.last_error, DATA_SOURCE_PREVIEW_ERROR_MAX_LENGTH)
      : undefined,
    status: row.status,
    updatedAt: formatDate(row.updated_at),
  };
}
