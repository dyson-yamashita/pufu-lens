import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_IDS = ['curate-workflow', 'generate-report', 'ingest-workflow'] as const;
const SOURCE_TYPES = ['drive', 'github', 'gmail', 'web'] as const;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

type WorkflowId = (typeof WORKFLOW_IDS)[number];
type SourceType = (typeof SOURCE_TYPES)[number];

type WorkflowInput = {
  dataSourceId?: string;
  drain?: boolean;
  dryRun?: boolean;
  embeddingProvider?: string;
  fixture?: boolean;
  limit?: number;
  maxBatches?: number;
  maxRuntimeSeconds?: number;
  period?: 'weekly';
  project?: string;
  projectSlug?: string;
  resumeFrom?: 'collect' | 'parse' | 'resolve' | 'chunk' | 'graph';
  source?: SourceType;
};

type JobPlan = {
  args: string[];
  input: WorkflowInput;
  workflowId: WorkflowId;
};

async function main(): Promise<void> {
  const workflowId = parseWorkflowId(process.env.WORKFLOW_ID ?? process.argv[2]);
  const input = parseWorkflowInput(process.env.WORKFLOW_INPUT_JSON);
  const plan = buildJobPlan(workflowId, input);

  logEvent({
    argv: redactArgv(plan.args),
    event: 'job_planned',
    input: summarizeInput(input),
    workflowId,
  });

  if (isDryRun(input)) {
    logEvent({ event: 'job_completed', mode: 'dry_run', workflowId });
    return;
  }

  await runNodeScript(plan.args);
  logEvent({ event: 'job_completed', mode: 'execute', workflowId });
}

function buildJobPlan(workflowId: WorkflowId, input: WorkflowInput): JobPlan {
  const projectSlug = requiredString(input.projectSlug ?? input.project, 'projectSlug');
  if (workflowId === 'generate-report') {
    const args = [
      join(repoRoot, 'scripts/generate-report.ts'),
      '--project',
      projectSlug,
      '--period',
      input.period ?? 'weekly',
    ];
    return { args, input, workflowId };
  }

  if (workflowId === 'ingest-workflow') {
    const args = [join(repoRoot, 'scripts/ingest-workflow.ts'), 'run', '--project', projectSlug];
    if (input.fixture) {
      args.push('--fixture');
    }
    appendCommonOptions(args, input);
    return { args, input, workflowId };
  }

  const source = requiredSource(input.source);
  const args = input.fixture
    ? [
        join(repoRoot, 'scripts/collect-fixture-source.ts'),
        '--project',
        projectSlug,
        '--source',
        source,
      ]
    : [join(repoRoot, 'scripts/collect-source.ts'), '--project', projectSlug, '--source', source];
  appendCommonOptions(args, input);
  return { args, input, workflowId };
}

function appendCommonOptions(args: string[], input: WorkflowInput): void {
  if (input.dataSourceId !== undefined) {
    args.push('--data-source-id', input.dataSourceId);
  }
  if (input.dryRun) {
    args.push('--dry-run');
  }
  if (input.drain) {
    args.push('--drain');
  }
  if (input.embeddingProvider !== undefined) {
    args.push('--embedding-provider', input.embeddingProvider);
  }
  if (input.limit !== undefined) {
    args.push('--limit', String(input.limit));
  }
  if (input.maxBatches !== undefined) {
    args.push('--max-batches', String(input.maxBatches));
  }
  if (input.maxRuntimeSeconds !== undefined) {
    args.push('--max-runtime-seconds', String(input.maxRuntimeSeconds));
  }
  if (input.resumeFrom !== undefined) {
    args.push('--resume-from', input.resumeFrom);
  }
  if (input.source && !args.includes('--source')) {
    args.push('--source', input.source);
  }
}

function parseWorkflowId(value: string | undefined): WorkflowId {
  if (isWorkflowId(value)) {
    return value;
  }
  throw new Error(`WORKFLOW_ID must be one of: ${WORKFLOW_IDS.join(', ')}`);
}

function parseWorkflowInput(value: string | undefined): WorkflowInput {
  if (!value) {
    throw new Error('WORKFLOW_INPUT_JSON is required.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `WORKFLOW_INPUT_JSON is not a valid JSON string: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WORKFLOW_INPUT_JSON must be an object.');
  }
  const input = parsed as Record<string, unknown>;
  return {
    dataSourceId: optionalString(input.dataSourceId, 'dataSourceId'),
    drain: optionalBoolean(input.drain, 'drain'),
    dryRun: optionalBoolean(input.dryRun, 'dryRun'),
    embeddingProvider: optionalString(input.embeddingProvider, 'embeddingProvider'),
    fixture: optionalBoolean(input.fixture, 'fixture'),
    limit: optionalPositiveInteger(input.limit, 'limit'),
    maxBatches: optionalPositiveInteger(input.maxBatches, 'maxBatches'),
    maxRuntimeSeconds: optionalPositiveInteger(input.maxRuntimeSeconds, 'maxRuntimeSeconds'),
    period: optionalPeriod(input.period),
    project: optionalString(input.project, 'project'),
    projectSlug: optionalString(input.projectSlug, 'projectSlug'),
    resumeFrom: optionalResumeFrom(input.resumeFrom),
    source: optionalSource(input.source),
  };
}

function isWorkflowId(value: string | undefined): value is WorkflowId {
  return WORKFLOW_IDS.some((workflowId) => workflowId === value);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function optionalPeriod(value: unknown): 'weekly' | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'weekly') {
    throw new Error('period must be weekly.');
  }
  return value;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

function optionalSource(value: unknown): SourceType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' && SOURCE_TYPES.some((sourceType) => sourceType === value)) {
    return value as SourceType;
  }
  throw new Error(`source must be one of: ${SOURCE_TYPES.join(', ')}`);
}

function optionalResumeFrom(value: unknown): WorkflowInput['resumeFrom'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === 'collect' ||
    value === 'parse' ||
    value === 'resolve' ||
    value === 'chunk' ||
    value === 'graph'
  ) {
    return value;
  }
  throw new Error('resumeFrom must be one of: collect, parse, resolve, chunk, graph.');
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function requiredSource(value: SourceType | undefined): SourceType {
  if (!value) {
    throw new Error('source is required for curate-workflow.');
  }
  return value;
}

function requiredString(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function isDryRun(input: WorkflowInput): boolean {
  return input.dryRun === true || process.env.DRY_RUN === 'true';
}

function summarizeInput(input: WorkflowInput): Record<string, unknown> {
  return {
    dataSourceId: input.dataSourceId,
    drain: input.drain ?? false,
    dryRun: isDryRun(input),
    embeddingProvider: input.embeddingProvider,
    fixture: input.fixture ?? false,
    limit: input.limit,
    maxBatches: input.maxBatches,
    maxRuntimeSeconds: input.maxRuntimeSeconds,
    period: input.period,
    projectSlug: input.projectSlug ?? input.project,
    resumeFrom: input.resumeFrom,
    source: input.source,
  };
}

function redactArgv(args: readonly string[]): string[] {
  return args.map((arg) => (arg.includes('://') ? '<redacted-uri>' : arg));
}

async function runNodeScript(args: readonly string[]): Promise<void> {
  const child = spawn(process.execPath, [...process.execArgv, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`workflow job failed with exit code ${exitCode ?? '<unknown>'}`);
  }
}

function logEvent(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ ...event, timestamp: new Date().toISOString() }));
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
