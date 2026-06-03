'use server';

import { revalidatePath } from 'next/cache';
import postgres from 'postgres';

export async function retryFailedQueue(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const dataSourceId = formData.get('dataSourceId')?.toString();
  await withSql(async (sql) => {
    const project = await lookupProject(sql, projectSlug);
    const dataSourceFilter = dataSourceId
      ? sql`AND ingestion_queue.data_source_id = ${dataSourceId}`
      : sql``;

    await sql`
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

    await sql`
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
  revalidateProject(projectSlug);
}

export async function approveParserVersion(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const parserProfileId = requireFormValue(formData, 'parserProfileId');
  const parserVersionId = requireFormValue(formData, 'parserVersionId');

  await withSql(async (sql) => {
    const project = await lookupProject(sql, projectSlug);
    await sql`
      UPDATE public.parser_versions
      SET status = 'approved',
          approved_at = now(),
          updated_at = now()
      WHERE id = ${parserVersionId}
        AND parser_profile_id = ${parserProfileId}
    `;
    await sql`
      UPDATE public.parser_profiles
      SET active_version_id = ${parserVersionId},
          updated_at = now()
      WHERE id = ${parserProfileId}
        AND project_id = ${project.id}
    `;
    await sql`
      UPDATE public.ingestion_queue
      SET status = 'pending',
          hold_reason = null,
          updated_at = now()
      WHERE project_id = ${project.id}
        AND parser_profile_id = ${parserProfileId}
        AND status = 'held'
    `;
    await sql`
      UPDATE public.raw_documents
      SET ingest_status = 'fetched',
          hold_reason = null,
          updated_at = now()
      WHERE project_id = ${project.id}
        AND parser_profile_id = ${parserProfileId}
        AND ingest_status = 'held'
    `;
  });
  revalidateProject(projectSlug);
}

export async function rejectParserVersion(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const parserVersionId = requireFormValue(formData, 'parserVersionId');
  await withSql(async (sql) => {
    await sql`
      UPDATE public.parser_versions
      SET status = 'retired',
          updated_at = now()
      WHERE id = ${parserVersionId}
    `;
  });
  revalidateProject(projectSlug);
}

async function withSql<T>(callback: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for admin actions.');
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    return await callback(sql);
  } finally {
    await sql.end();
  }
}

async function lookupProject(
  sql: postgres.Sql,
  projectSlug: string,
): Promise<{ readonly id: string; readonly slug: string }> {
  const rows = (await sql`
    SELECT id::text AS id, slug
    FROM public.projects
    WHERE slug = ${projectSlug}
  `) as Array<{ id: string; slug: string }>;
  const project = rows[0];
  if (!project) {
    throw new Error(`Unknown project slug: ${projectSlug}`);
  }
  return project;
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
