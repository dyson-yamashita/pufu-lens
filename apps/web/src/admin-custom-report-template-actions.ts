'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminProject, requireFormValue, withSql } from './admin-actions-shared.ts';
import {
  CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION,
  type CustomReportLayoutV1,
  validateCustomReportLayout,
  validateCustomReportTemplateExport,
} from './custom-report-schema.ts';

export async function createCustomReportTemplate(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const name = requireFormValue(formData, 'name').trim();
  const description = optionalFormValue(formData, 'description');
  const layout = parseLayoutJson(requireFormValue(formData, 'layoutJson'));
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await sql`
      INSERT INTO public.custom_report_templates (
        project_id, name, description, schema_version, layout, created_by_user_id, updated_by_user_id
      )
      VALUES (
        ${project.id}, ${name}, ${description}, ${CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION},
        ${JSON.stringify(layout)}::jsonb, ${project.adminUserId}, ${project.adminUserId}
      )
    `;
  });
  revalidateCustomReportTemplates(projectSlug);
}

export async function updateCustomReportTemplate(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const templateId = requireFormValue(formData, 'templateId');
  const name = requireFormValue(formData, 'name').trim();
  const description = optionalFormValue(formData, 'description');
  const layout = parseLayoutJson(requireFormValue(formData, 'layoutJson'));
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await sql`
      UPDATE public.custom_report_templates
      SET name = ${name},
          description = ${description},
          layout = ${JSON.stringify(layout)}::jsonb,
          template_version = template_version + 1,
          updated_by_user_id = ${project.adminUserId}
      WHERE project_id = ${project.id} AND id = ${templateId}
    `;
  });
  revalidateCustomReportTemplates(projectSlug);
}

export async function disableCustomReportTemplate(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const templateId = requireFormValue(formData, 'templateId');
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await sql`
      UPDATE public.custom_report_templates
      SET is_active = false, updated_by_user_id = ${project.adminUserId}
      WHERE project_id = ${project.id} AND id = ${templateId}
    `;
  });
  revalidateCustomReportTemplates(projectSlug);
}

export async function importCustomReportTemplate(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const exportJson = JSON.parse(requireFormValue(formData, 'exportJson')) as unknown;
  validateCustomReportTemplateExport(exportJson);
  if (exportJson.assets.length > 0) {
    throw new Error(
      'Asset upload mapping is not implemented yet. Import templates without asset manifest first.',
    );
  }
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await sql`
      INSERT INTO public.custom_report_templates (
        project_id, name, description, schema_version, layout, created_by_user_id, updated_by_user_id
      )
      VALUES (
        ${project.id}, ${exportJson.template.name}, ${exportJson.template.description ?? null},
        ${CUSTOM_REPORT_TEMPLATE_SCHEMA_VERSION}, ${JSON.stringify(exportJson.template.layout)}::jsonb,
        ${project.adminUserId}, ${project.adminUserId}
      )
    `;
  });
  revalidateCustomReportTemplates(projectSlug);
}

function parseLayoutJson(value: string): CustomReportLayoutV1 {
  const parsed = JSON.parse(value) as unknown;
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
