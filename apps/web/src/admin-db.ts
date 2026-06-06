import type postgres from 'postgres';
import {
  type DataSourceSummary,
  fallbackProjects,
  fallbackPublicProjects,
  type ParserProfileStatus,
  type ParserProfileSummary,
  type ProjectSummary,
  type ProjectVisibility,
  type PublicProjectReportSummary,
  type PublicProjectSummary,
  type SourceStatus,
  type SourceType,
} from './admin-data';
import { getOptionalAdminSql } from './admin-sql';

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
  report_id: string;
  report_summary: string | null;
  report_title: string;
  slug: string;
};

type MutablePublicProjectSummary = Omit<PublicProjectSummary, 'reports'> & {
  reports: PublicProjectReportSummary[];
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
    return projects.length > 0 ? projects : fallbackProjects;
  }, fallbackProjects);
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
  }, fallbackPublicProjects);
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
    const fallback = fallbackProjects.find((candidate) => candidate.slug === slug);
    if (fallback) {
      console.warn(error instanceof Error ? error.message : String(error));
      return fallback;
    }
    throw error;
  }
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
    project.reports.push({
      id: row.report_id,
      publishedAt: formatDate(row.published_at),
      summary: row.report_summary ?? '',
      title: row.report_title,
    });
    projects.set(row.slug, project);
  }
  return Array.from(projects.values());
}

async function withOptionalSql<T>(
  callback: (sql: postgres.Sql) => Promise<T>,
  fallback: T,
): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return fallback;
  }

  const sql = getOptionalAdminSql();
  if (!sql) {
    return fallback;
  }
  try {
    return await callback(sql);
  } catch (error) {
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
