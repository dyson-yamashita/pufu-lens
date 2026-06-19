'use server';

import type postgres from 'postgres';
import {
  type AdminActionParserVersionRow,
  parseAdminActionParserVersionRow,
} from './admin-actions-guards.ts';
import {
  parseOptionalAdminActionRow,
  requireAdminProject,
  requireFormValue,
  revalidateProject,
  withSql,
} from './admin-actions-shared.ts';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

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

async function lookupProjectParserVersion(
  sql: SqlExecutor,
  projectId: string,
  parserProfileId: string | undefined,
  parserVersionId: string,
): Promise<AdminActionParserVersionRow> {
  const parserVersion = await lookupProjectParserVersionRow(
    sql,
    projectId,
    parserProfileId,
    parserVersionId,
  );
  if (!parserVersion) {
    throw new Error('Parser version not found in project.');
  }
  return parserVersion;
}

async function lookupProjectParserVersionRow(
  sql: SqlExecutor,
  projectId: string,
  parserProfileId: string | undefined,
  parserVersionId: string,
): Promise<AdminActionParserVersionRow | undefined> {
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
    FOR UPDATE
  `) as readonly unknown[];
  return parseOptionalAdminActionRow(rows, parseAdminActionParserVersionRow);
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
