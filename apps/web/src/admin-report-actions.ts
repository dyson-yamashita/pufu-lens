'use server';

import {
  requireAdminProject,
  requireFormValue,
  revalidateProject,
  withSql,
} from './admin-actions-shared.ts';
import {
  createExtractiveReportProvider,
  createGeminiReportProvider,
  createPostgresReportRepository,
  createReportStorageFromEnv,
  type ReportGenerationProvider,
  reportNowFromEnv,
  runGenerateReport,
} from './report';

export async function generatePrivateReport(formData: FormData): Promise<void> {
  const projectSlug = requireFormValue(formData, 'projectSlug');
  const period = requireReportPeriod(formData);
  await withSql(async (sql) => {
    await requireAdminProject(sql, projectSlug);
    await runGenerateReport({
      options: {
        generatedBy: 'admin-ui',
        now: reportNowFromEnv(process.env),
        period,
        provider: createReportProvider(),
        repository: createPostgresReportRepository(sql),
        storage: createReportStorageFromEnv(),
      },
      projectSlug,
    });
  });
  revalidateProject(projectSlug);
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

function createReportProvider(): ReportGenerationProvider {
  const fallbackProvider = createExtractiveReportProvider();
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_CHAT_MODEL) {
    const geminiProvider = createGeminiReportProvider({
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_CHAT_MODEL,
    });
    return {
      async generate(input) {
        try {
          return await geminiProvider.generate(input);
        } catch (error) {
          console.warn(
            'Gemini report generation failed; falling back to extractive provider.',
            error instanceof Error ? error.message : String(error),
          );
          return fallbackProvider.generate(input);
        }
      },
    };
  }
  return fallbackProvider;
}
