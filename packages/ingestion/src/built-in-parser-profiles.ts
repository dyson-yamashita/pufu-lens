import {
  parseBuiltInParserProfileIdRow,
  parseBuiltInParserProfileTargetRows,
  parseFirstSqlRow,
} from './built-in-parser-profile-row-parsers.js';
import type { SourceType } from './ingestion-fixtures.js';
import {
  BUILT_IN_PARSER_ARTIFACT_HASH,
  BUILT_IN_PARSER_VERSION,
  defaultParserContract,
  PARSED_SCHEMA_VERSION,
} from './raw-parse.js';

const BUILT_IN_SOURCE_TYPES = [
  'github',
  'web',
  'gmail',
  'drive',
] as const satisfies readonly SourceType[];

/** Minimal SQL executor surface used to seed built-in parser profiles without depending on postgres types. */
export type BuiltInParserProfileSql = {
  // postgres.Sql is structurally compatible but its overloads are wider than this helper surface.
  (...args: unknown[]): unknown;
  json(value: unknown): unknown;
};

type ParserProfileTarget = {
  dataSourceId: string;
  projectId: string;
  sourceType: SourceType;
};

/**
 * Returns the canonical built-in parser profile name for a source type.
 *
 * Managed profiles are always kept on approved `fixture-parser-v2` as the active version.
 */
export function builtInParserProfileName(sourceType: SourceType): string {
  return `Built-in ${sourceType} parser`;
}

/**
 * Ensures the built-in parser profile for one project / data source / source type exists,
 * inserts approved `fixture-parser-v2` when missing, and activates it in a follow-up statement.
 */
export async function ensureBuiltInParserProfileForDataSource(input: {
  approvedByUserId: string;
  dataSourceId: string;
  managedBy: string;
  projectId: string;
  sourceType: SourceType;
  sql: BuiltInParserProfileSql;
}): Promise<void> {
  const profileId = await upsertBuiltInParserProfile(input);
  await insertBuiltInParserVersionIfMissing({
    approvedByUserId: input.approvedByUserId,
    profileId,
    sourceType: input.sourceType,
    sql: input.sql,
  });
  await activateBuiltInParserVersion({
    profileId,
    sql: input.sql,
  });
}

/**
 * Seeds built-in parser profiles for enabled data sources in a project scope.
 *
 * When `sourceType` is omitted, all built-in source types are considered. When `dataSourceId`
 * is provided, only that data source is updated.
 */
export async function ensureBuiltInParserProfilesForProjectScope(input: {
  approvedByUserId: string;
  dataSourceId?: string;
  managedBy: string;
  projectSlug: string;
  sourceType?: SourceType;
  sql: BuiltInParserProfileSql;
}): Promise<void> {
  const targets = await listBuiltInParserProfileTargets({
    dataSourceId: input.dataSourceId,
    projectSlug: input.projectSlug,
    sourceType: input.sourceType,
    sql: input.sql,
  });

  for (const target of targets) {
    await ensureBuiltInParserProfileForDataSource({
      approvedByUserId: input.approvedByUserId,
      dataSourceId: target.dataSourceId,
      managedBy: input.managedBy,
      projectId: target.projectId,
      sourceType: target.sourceType,
      sql: input.sql,
    });
  }
}

async function listBuiltInParserProfileTargets(input: {
  dataSourceId?: string;
  projectSlug: string;
  sourceType?: SourceType;
  sql: BuiltInParserProfileSql;
}): Promise<ParserProfileTarget[]> {
  const sourceTypes = input.sourceType ? [input.sourceType] : BUILT_IN_SOURCE_TYPES;
  const targets: ParserProfileTarget[] = [];

  for (const sourceType of sourceTypes) {
    const rows = parseBuiltInParserProfileTargetRows(
      await input.sql`
      SELECT
        ds.id::text AS "dataSourceId",
        ds.project_id::text AS "projectId",
        ds.source_type AS "sourceType"
      FROM public.data_sources ds
      JOIN public.projects p ON p.id = ds.project_id
      WHERE p.slug = ${input.projectSlug}
        AND ds.enabled = true
        AND ds.source_type = ${sourceType}
        AND (${input.dataSourceId ?? null}::uuid IS NULL OR ds.id = ${input.dataSourceId ?? null}::uuid)
      ORDER BY ds.id
    `,
    );
    targets.push(...rows);
  }

  return targets;
}

async function upsertBuiltInParserProfile(input: {
  dataSourceId: string;
  managedBy: string;
  projectId: string;
  sourceType: SourceType;
  sql: BuiltInParserProfileSql;
}): Promise<string> {
  const row = await input.sql`
    INSERT INTO public.parser_profiles (
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
      ${builtInParserProfileName(input.sourceType)},
      ${input.sql.json({ managedBy: input.managedBy })}
    )
    ON CONFLICT (project_id, data_source_id, source_type, name)
    DO UPDATE SET
      metadata = EXCLUDED.metadata,
      updated_at = now()
    RETURNING id::text AS id
  `;
  return parseBuiltInParserProfileIdRow(parseFirstSqlRow(row, 'built-in parser profile upsert')).id;
}

async function insertBuiltInParserVersionIfMissing(input: {
  approvedByUserId: string;
  profileId: string;
  sourceType: SourceType;
  sql: BuiltInParserProfileSql;
}): Promise<void> {
  await input.sql`
    INSERT INTO public.parser_versions (
      parser_profile_id,
      version,
      schema_version,
      artifact_hash,
      contract,
      status,
      approved_by_user_id,
      approved_at
    )
    VALUES (
      ${input.profileId},
      ${BUILT_IN_PARSER_VERSION},
      ${PARSED_SCHEMA_VERSION},
      ${BUILT_IN_PARSER_ARTIFACT_HASH},
      ${input.sql.json(defaultParserContract(input.sourceType))},
      'approved',
      ${input.approvedByUserId},
      now()
    )
    ON CONFLICT (parser_profile_id, version) DO NOTHING
  `;
}

async function activateBuiltInParserVersion(input: {
  profileId: string;
  sql: BuiltInParserProfileSql;
}): Promise<void> {
  // Built-in managed profiles intentionally stay on approved v2; skip writes when already active.
  await input.sql`
    UPDATE public.parser_profiles AS pp
    SET
      active_version_id = pv.id,
      updated_at = now()
    FROM public.parser_versions AS pv
    WHERE pv.parser_profile_id = pp.id
      AND pp.id = ${input.profileId}
      AND pv.version = ${BUILT_IN_PARSER_VERSION}
      AND pv.status = 'approved'
      AND pp.active_version_id IS DISTINCT FROM pv.id
  `;
}
