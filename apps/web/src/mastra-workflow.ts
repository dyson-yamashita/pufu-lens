import type { ReportPeriod } from './report.ts';
import { mastraFetchHeaders } from './mastra-chat.ts';

const GENERATE_REPORT_WORKFLOW_ID = 'generate-report';

type MastraWorkflowEnv = Record<string, string | undefined>;
type MastraWorkflowExecutionResult = {
  readonly error?: unknown;
  readonly result?: unknown;
  readonly status?: string;
};

export function mastraGenerateReportWorkflowStartUrl(env: MastraWorkflowEnv = process.env): string {
  const rawBase = env.MASTRA_SERVER_URL ?? env.MASTRA_API_URL ?? 'http://localhost:4111';
  const base = rawBase.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${base}/api/workflows/${GENERATE_REPORT_WORKFLOW_ID}/start-async`;
}

export function createMastraGenerateReportWorkflowBody(input: {
  readonly generatedBy?: string;
  readonly nowIso?: string;
  readonly period?: ReportPeriod;
  readonly projectSlug: string;
}) {
  return {
    inputData: {
      ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}),
      ...(input.nowIso ? { nowIso: input.nowIso } : {}),
      ...(input.period ? { period: input.period } : {}),
      projectSlug: input.projectSlug,
    },
  };
}

export async function runMastraGenerateReportWorkflow(input: {
  readonly fetchImpl?: typeof fetch;
  readonly generatedBy?: string;
  readonly nowIso?: string;
  readonly period?: ReportPeriod;
  readonly projectSlug: string;
}): Promise<void> {
  const url = mastraGenerateReportWorkflowStartUrl();
  const response = await (input.fetchImpl ?? fetch)(url, {
    body: JSON.stringify(
      createMastraGenerateReportWorkflowBody({
        generatedBy: input.generatedBy,
        nowIso: input.nowIso,
        period: input.period,
        projectSlug: input.projectSlug,
      }),
    ),
    headers: await mastraFetchHeaders({ url }),
    method: 'POST',
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `Mastra generate report workflow failed: HTTP ${response.status} - ${truncateWorkflowError(
        errorText,
      )}`,
    );
  }
  const result = (await response.json().catch(() => ({}))) as MastraWorkflowExecutionResult;
  if (result.status && result.status !== 'success') {
    throw new Error(
      `Mastra generate report workflow did not complete successfully: ${result.status}${
        result.error ? ` - ${truncateWorkflowError(JSON.stringify(result.error))}` : ''
      }`,
    );
  }
}

function truncateWorkflowError(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 2000) {
    return trimmed;
  }
  return trimmed.slice(-2000);
}
