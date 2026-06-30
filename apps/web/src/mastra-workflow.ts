import { mastraFetchHeaders } from './mastra-chat.ts';
import type { ReportPeriod } from './report.ts';

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

/**
 * Builds the request body for starting the generate report workflow.
 *
 * @param input - Workflow input fields to include in the request body.
 * @returns An object containing `inputData` for the workflow start request.
 */
export function createMastraGenerateReportWorkflowBody(input: {
  readonly generatedBy?: string;
  readonly customTemplateId?: string;
  readonly nowIso?: string;
  readonly period?: ReportPeriod;
  readonly projectSlug: string;
}) {
  return {
    inputData: {
      ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}),
      ...(input.customTemplateId ? { customTemplateId: input.customTemplateId } : {}),
      ...(input.nowIso ? { nowIso: input.nowIso } : {}),
      ...(input.period ? { period: input.period } : {}),
      projectSlug: input.projectSlug,
    },
  };
}

/**
 * Starts the Mastra generate report workflow.
 *
 * @param input.projectSlug - Project slug included in the workflow input.
 * @param input.generatedBy - Identifier for the user or system that generated the report.
 * @param input.customTemplateId - Template identifier to include in the workflow input.
 * @param input.nowIso - ISO timestamp to include in the workflow input.
 * @param input.period - Report period to include in the workflow input.
 * @throws If the workflow request fails or the workflow reports a non-success status.
 */
export async function runMastraGenerateReportWorkflow(input: {
  readonly env?: MastraWorkflowEnv;
  readonly fetchImpl?: typeof fetch;
  readonly generatedBy?: string;
  readonly customTemplateId?: string;
  readonly nowIso?: string;
  readonly period?: ReportPeriod;
  readonly projectSlug: string;
}): Promise<void> {
  const env = input.env ?? process.env;
  const url = mastraGenerateReportWorkflowStartUrl(env);
  const response = await (input.fetchImpl ?? fetch)(url, {
    body: JSON.stringify(
      createMastraGenerateReportWorkflowBody({
        generatedBy: input.generatedBy,
        customTemplateId: input.customTemplateId,
        nowIso: input.nowIso,
        period: input.period,
        projectSlug: input.projectSlug,
      }),
    ),
    headers: await mastraFetchHeaders({ env, url }),
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
