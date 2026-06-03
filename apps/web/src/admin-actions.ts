'use server';

import { revalidatePath } from 'next/cache';
import type postgres from 'postgres';
import { getRequiredAdminSql } from './admin-sql';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

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

async function requireAdminProject(
  sql: postgres.Sql,
  projectSlug: string,
): Promise<{ readonly adminUserId: string; readonly id: string; readonly slug: string }> {
  if (process.env.PUFU_LENS_ENABLE_ADMIN_ACTIONS !== 'true') {
    throw new Error('Admin actions are disabled.');
  }
  const adminUserId = process.env.PUFU_LENS_ADMIN_USER_ID;
  if (!adminUserId) {
    throw new Error('PUFU_LENS_ADMIN_USER_ID is required for admin actions.');
  }
  const rows = (await sql`
    SELECT projects.id::text AS id, projects.slug, project_members.user_id::text AS admin_user_id
    FROM public.projects
    JOIN public.project_members ON project_members.project_id = projects.id
    WHERE projects.slug = ${projectSlug}
      AND project_members.user_id = ${adminUserId}
      AND project_members.role = 'admin'
  `) as Array<{ admin_user_id: string; id: string; slug: string }>;
  const project = rows[0];
  if (!project) {
    throw new Error(`Admin access denied for project slug: ${projectSlug}`);
  }
  return { adminUserId: project.admin_user_id, id: project.id, slug: project.slug };
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
}
