'use server';

import { revalidatePath } from 'next/cache';
import type postgres from 'postgres';
import { requireAdminProject, requireFormValue, withSql } from './admin-actions-shared.ts';
import {
  CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION,
  type CustomReportLayoutV1,
  validateCustomReportLayout,
  validateCustomReportTemplateExport,
} from './custom-report-schema.ts';

type AdminProject = Awaited<ReturnType<typeof requireAdminProject>>;
type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export async function createCustomReportTemplate(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const name = requireNonEmptyTemplateName(requireFormValue(formData, 'name'));
  const description = optionalFormValue(formData, 'description');
  const layout = parseLayoutJson(requireFormValue(formData, 'layoutJson'));
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await insertCustomReportTemplate(sql, project, { name, description, layout });
  });
  revalidateCustomReportTemplates(projectSlug);
}

export async function updateCustomReportTemplate(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const templateId = requireFormValue(formData, 'templateId');
  const name = requireNonEmptyTemplateName(requireFormValue(formData, 'name'));
  const description = optionalFormValue(formData, 'description');
  const layout = parseLayoutJson(requireFormValue(formData, 'layoutJson'));
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    const result = await sql`
      UPDATE public.custom_report_templates
      SET name = ${name},
          description = ${description},
          layout = ${JSON.stringify(layout)}::jsonb,
          template_version = template_version + 1,
          updated_by_user_id = ${project.adminUserId}
      WHERE project_id = ${project.id} AND id = ${templateId}
    `;
    if (result.count === 0) {
      throw new Error('Template not found or access denied.');
    }
  });
  revalidateCustomReportTemplates(projectSlug);
}

export async function disableCustomReportTemplate(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const templateId = requireFormValue(formData, 'templateId');
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    const result = await sql`
      UPDATE public.custom_report_templates
      SET is_active = false, updated_by_user_id = ${project.adminUserId}
      WHERE project_id = ${project.id} AND id = ${templateId}
    `;
    if (result.count === 0) {
      throw new Error('Template not found or access denied.');
    }
  });
  revalidateCustomReportTemplates(projectSlug);
}

export async function importCustomReportTemplate(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const exportJson = parseJsonField(formData, 'exportJson');
  validateCustomReportTemplateExport(exportJson);
  if (exportJson.assets.length > 0) {
    throw new Error(
      'Asset upload mapping is not implemented yet. Import templates without asset manifest first.',
    );
  }
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await insertCustomReportTemplate(sql, project, {
      name: exportJson.template.name,
      description: exportJson.template.description ?? null,
      layout: exportJson.template.layout,
    });
  });
  revalidateCustomReportTemplates(projectSlug);
}

async function insertCustomReportTemplate(
  sql: SqlExecutor,
  project: AdminProject,
  params: {
    readonly name: string;
    readonly description: string | null;
    readonly layout: CustomReportLayoutV1;
  },
): Promise<void> {
  await sql`
    INSERT INTO public.custom_report_templates (
      project_id, name, description, schema_version, layout, created_by_user_id, updated_by_user_id
    )
    VALUES (
      ${project.id}, ${params.name}, ${params.description}, ${CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION},
      ${JSON.stringify(params.layout)}::jsonb, ${project.adminUserId}, ${project.adminUserId}
    )
  `;
}

function requireNonEmptyTemplateName(value: string): string {
  const name = value.trim();
  if (!name) {
    throw new Error('name is required.');
  }
  return name;
}

function parseJsonField(formData: FormData, fieldName: string): unknown {
  return parseJsonString(requireFormValue(formData, fieldName), fieldName);
}

function parseJsonString(raw: string, context: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? `Invalid JSON in ${context}: ${error.message}`
        : `Invalid JSON in ${context}`;
    throw new Error(message);
  }
}

function parseLayoutJson(value: string): CustomReportLayoutV1 {
  const parsed = parseJsonString(value, 'layoutJson');
  validateCustomReportLayout(parsed);
  return parsed;
}

function optionalFormValue(formData: FormData, key: string): string | null {
  const value = formData.get(key)?.toString().trim();
  return value ? value : null;
}

function revalidateCustomReportTemplates(projectSlug: string): void {
  revalidatePath(`/projects/${projectSlug}/admin/custom-report-templates`);
  revalidatePath(`/projects/${projectSlug}/reports`);
}
