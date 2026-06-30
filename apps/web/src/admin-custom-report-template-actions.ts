'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminProject, requireFormValue, withSql } from './admin-actions-shared.ts';
import * as customReportRepository from './custom-report-repository.ts';
import {
  type CustomReportLayoutV1,
  validateCustomReportLayout,
  validateCustomReportTemplateExport,
} from './custom-report-schema.ts';

export async function createCustomReportTemplate(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const name = requireNonEmptyTemplateName(requireFormValue(formData, 'name'));
  const description = optionalFormValue(formData, 'description');
  const layout = parseLayoutJson(requireFormValue(formData, 'layoutJson'));
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await customReportRepository.insertCustomReportTemplate(sql, {
      projectId: project.id,
      name,
      description,
      layout,
      createdByUserId: project.adminUserId,
    });
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
    await customReportRepository.updateCustomReportTemplate(sql, {
      projectId: project.id,
      templateId,
      name,
      description,
      layout,
      updatedByUserId: project.adminUserId,
    });
  });
  revalidateCustomReportTemplates(projectSlug);
}

export async function disableCustomReportTemplate(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const templateId = requireFormValue(formData, 'templateId');
  await withSql(async (sql) => {
    const project = await requireAdminProject(sql, projectSlug);
    await customReportRepository.disableCustomReportTemplate(sql, {
      projectId: project.id,
      templateId,
      updatedByUserId: project.adminUserId,
    });
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
    await customReportRepository.insertCustomReportTemplate(sql, {
      projectId: project.id,
      name: exportJson.template.name,
      description: exportJson.template.description ?? null,
      layout: exportJson.template.layout,
      createdByUserId: project.adminUserId,
    });
  });
  revalidateCustomReportTemplates(projectSlug);
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
