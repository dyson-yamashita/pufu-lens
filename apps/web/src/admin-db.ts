import postgres from 'postgres';
import {
  type DataSourceSummary,
  fallbackProjects,
  type ParserProfileStatus,
  type ParserProfileSummary,
  type ProjectSummary,
  type SourceStatus,
  type SourceType,
} from './admin-data';

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
  source_type: SourceType;
};

export async function listAdminProjects(): Promise<readonly ProjectSummary[]> {
  return withOptionalSql(async (sql) => {
    const rows = (await sql`
      SELECT
        projects.id::text AS id,
        projects.slug,
        projects.name,
        projects.description,
        count(DISTINCT project_members.user_id)::int AS member_count,
        count(DISTINCT raw_documents.id)::int AS raw_count,
        count(DISTINCT ingestion_queue.id)::int AS queue_count,
        count(DISTINCT raw_documents.id) FILTER (WHERE raw_documents.ingest_status = 'failed')::int AS failed_count,
        count(DISTINCT raw_documents.id) FILTER (WHERE raw_documents.ingest_status = 'held')::int AS held_count,
        max(raw_documents.indexed_at) AS last_indexed
      FROM public.projects
      LEFT JOIN public.project_members ON project_members.project_id = projects.id
      LEFT JOIN public.raw_documents ON raw_documents.project_id = projects.id
      LEFT JOIN public.ingestion_queue ON ingestion_queue.project_id = projects.id
      GROUP BY projects.id
      ORDER BY projects.slug
    `) as ProjectRow[];

    const projects = await Promise.all(
      rows.map(async (row) => {
        const [dataSources, parserProfiles] = await Promise.all([
          listDataSources(sql, row.id),
          listParserProfiles(sql, row.id),
        ]);
        return projectFromRow(row, dataSources, parserProfiles);
      }),
    );
    return projects.length > 0 ? projects : fallbackProjects;
  }, fallbackProjects);
}

export async function getAdminProject(slug: string): Promise<ProjectSummary> {
  const projects = await listAdminProjects();
  const project = projects.find((candidate) => candidate.slug === slug);
  if (!project) {
    throw new Error(`Unknown project slug: ${slug}`);
  }
  return project;
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

async function listDataSources(
  sql: postgres.Sql,
  projectId: string,
): Promise<readonly DataSourceSummary[]> {
  const rows = (await sql`
    SELECT
      data_sources.id::text AS id,
      data_sources.name,
      data_sources.source_type,
      data_sources.config,
      data_sources.last_checked_at,
      count(DISTINCT raw_documents.id)::int AS raw_count,
      count(DISTINCT ingestion_queue.id)::int AS queue_count,
      count(DISTINCT ingestion_queue.id) FILTER (WHERE ingestion_queue.status = 'failed')::int AS failed_count,
      count(DISTINCT ingestion_queue.id) FILTER (WHERE ingestion_queue.status = 'held')::int AS held_count,
      max(raw_documents.indexed_at) AS last_indexed
    FROM public.data_sources
    LEFT JOIN public.raw_document_data_sources
      ON raw_document_data_sources.data_source_id = data_sources.id
    LEFT JOIN public.raw_documents
      ON raw_documents.id = raw_document_data_sources.raw_document_id
    LEFT JOIN public.ingestion_queue
      ON ingestion_queue.data_source_id = data_sources.id
    WHERE data_sources.project_id = ${projectId}
      AND data_sources.enabled = true
    GROUP BY data_sources.id
    ORDER BY data_sources.source_type, data_sources.name
  `) as DataSourceRow[];

  return rows.map((row) => {
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
      scope: summarizeScope(row.source_type, row.config),
      sourceType: row.source_type,
      status: statusFromCounts({ failedCount, heldCount, queueCount }),
    };
  });
}

async function listParserProfiles(
  sql: postgres.Sql,
  projectId: string,
): Promise<readonly ParserProfileSummary[]> {
  const rows = (await sql`
    SELECT
      parser_profiles.id::text AS id,
      parser_profiles.name,
      parser_profiles.source_type,
      active_versions.version AS active_version,
      review_versions.id::text AS review_version_id,
      review_versions.version AS review_version,
      review_versions.status AS review_status,
      review_versions.validation_report_uri AS review_validation_report_uri,
      count(DISTINCT ingestion_queue.id) FILTER (WHERE ingestion_queue.status = 'held')::int AS held_queue_count
    FROM public.parser_profiles
    LEFT JOIN public.parser_versions AS active_versions
      ON active_versions.id = parser_profiles.active_version_id
    LEFT JOIN public.parser_versions AS review_versions
      ON review_versions.parser_profile_id = parser_profiles.id
      AND review_versions.status IN ('draft', 'review_requested')
    LEFT JOIN public.ingestion_queue
      ON ingestion_queue.parser_profile_id = parser_profiles.id
    WHERE parser_profiles.project_id = ${projectId}
    GROUP BY parser_profiles.id, active_versions.version, review_versions.id
    ORDER BY parser_profiles.source_type, parser_profiles.name, review_versions.created_at DESC NULLS LAST
  `) as ParserProfileRow[];

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
  };
}

async function withOptionalSql<T>(
  callback: (sql: postgres.Sql) => Promise<T>,
  fallback: T,
): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return fallback;
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await callback(sql);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : String(error));
    return fallback;
  } finally {
    await sql.end();
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
  const object = isRecord(config) ? config : {};
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

function summarizeConfig(sourceType: SourceType, config: unknown): string {
  const object = isRecord(config) ? config : {};
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
  return new Date(value).toISOString().replace('T', ' ').slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: number | string | bigint): number {
  return Number(value);
}
