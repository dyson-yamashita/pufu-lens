'use server';

import {
  requireAdminProject,
  requireFormValue,
  revalidateProject,
  withSql,
} from './admin-actions-shared.ts';
import { runMastraGenerateReportWorkflow } from './mastra-workflow.ts';
import { reportNowFromEnv } from './report';

export async function generatePrivateReport(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const period = requireReportPeriod(formData);
  await withSql(async (sql) => {
    await requireAdminProject(sql, projectSlug);
  });
  await runMastraGenerateReportWorkflow({
    customTemplateId: optionalFormValue(formData, 'customTemplateId'),
    generatedBy: 'admin-ui',
    nowIso: reportNowFromEnv(process.env)?.toISOString(),
    period,
    projectSlug,
  });
  revalidateProject(projectSlug);
}

function optionalFormValue(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function requireReportPeriod(formData: FormData): { readonly end: string; readonly start: string } {
  const start = requireIsoDate(requireFormValue(formData, 'periodStart'), 'periodStart');
  const end = requireIsoDate(requireFormValue(formData, 'periodEnd'), 'periodEnd');
  if (start > end) {
    throw new Error('periodStart must be before or equal to periodEnd.');
  }
  return { end, start };
}

function requireIsoDate(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`${fieldName} must be YYYY-MM-DD.`);
  }
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new Error(`${fieldName} must be a valid date.`);
  }
  return trimmed;
}
