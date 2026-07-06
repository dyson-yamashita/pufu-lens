import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { SourceType } from '../packages/ingestion/dist/index.js';
import { ensureIngestionQueueLeaseColumn } from './ingestion-queue-lease.ts';
import { requiredEnv } from './lib/cli.ts';
import {
  type DrainRemainingState,
  hasDrainRemainingWork,
  hasGraphStep,
  shouldContinueDrainAfterBatch,
  shouldCountParsedRaw,
  summarizeDrainRemaining,
} from './lib/ingest-workflow-drain.ts';

const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'] as const;
const STEP_ORDER = ['collect', 'parse', 'resolve', 'chunk', 'graph'] as const;
const DEFAULT_DRAIN_MAX_BATCHES = 100;
const DEFAULT_DRAIN_MAX_RUNTIME_SECONDS = 540;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

type WorkflowStep = (typeof STEP_ORDER)[number];
type WorkflowCommand = 'run' | 'retry';

type WorkflowOptions = {
  dataSourceId?: string;
  drain?: boolean;
  dryRun?: boolean;
  embeddingProvider?: string;
  failedOnly?: boolean;
  fixture?: boolean;
  folderIds?: string[];
  folderUrls?: string[];
  labelIds?: string[];
  limit?: number;
  maxBatches?: number;
  maxRuntimeSeconds?: number;
  project?: string;
  query?: string;
  repositories?: string[];
  resumeFrom?: WorkflowStep;
  source?: SourceType;
  state?: 'all' | 'closed' | 'open';
  step?: WorkflowStep;
  urls?: string[];
};

type DrainScope = {
  dataSourceId?: string;
  sourceType?: SourceType;
};

type DrainStopReason = 'dry_run' | 'max_batches' | 'max_runtime' | 'no_progress' | 'queue_empty';

type StepExecutionResult = {
  progressCount: number;
  result: ScriptResult;
};

type CountRow = {
  count: number;
  name: string;
};

type FailedQueueItem = {
  attempts: number;
  holdReason: string | null;
  lastError: string | null;
  sourceId: string;
  sourceType: string;
  status: string;
};

type ProjectRecord = {
  id: string;
  slug: string;
};

type LlmUsage = {
  agentCalls: number;
  chatModelCalls: number;
  embeddingModelCalls: number;
  tokenUsage: number;
};

type RunLogger = {
  command: WorkflowCommand;
  projectSlug: string;
  runId: string;
  sourceType?: SourceType;
};

type StepCommand = {
  args: string[];
};

type ScriptResult = Record<string, unknown> & {
  failureCount?: number;
  llm?: LlmUsage;
};

type ResetFailedQueueResult = {
  queueItems: number;
  rawDocuments: number;
};

type WorkflowEvent = Record<string, unknown>;

type Totals = {
  documentChunks: number;
  documents: number;
  emailQuotes: number;
  queueItems: number;
  rawDocuments: number;
};

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  const options = parseArgs(argv);

  if (command === 'run') {
    await runCommand(options);
    return;
  }
  if (command === 'status') {
    await statusCommand(options);
    return;
  }
  if (command === 'retry') {
    await retryCommand(options);
    return;
  }

  throw new Error(`Unknown workflow command: ${command ?? '<missing>'}`);
}

async function runCommand(options: WorkflowOptions): Promise<void> {
  const projectSlug = requiredOption(options.project, '--project');
  if (
    !options.fixture &&
    options.source !== 'web' &&
    options.source !== 'github' &&
    options.source !== 'drive' &&
    options.source !== 'gmail'
  ) {
    throw new Error('--fixture is required unless --source web, github, drive, or gmail is used.');
  }

  const run = createRunLogger({ command: 'run', projectSlug, sourceType: options.source });
  const steps = selectSteps(options);
  validateDrainOptions(options, steps);
  logEvent(run, {
    drain: options.drain ?? false,
    dryRun: options.dryRun ?? false,
    embeddingProvider: options.embeddingProvider ?? 'deterministic',
    event: 'workflow_started',
    llm: noLlmUsage(),
    ...(options.drain
      ? {
          maxBatches: options.maxBatches ?? DEFAULT_DRAIN_MAX_BATCHES,
          maxRuntimeSeconds: options.maxRuntimeSeconds ?? DEFAULT_DRAIN_MAX_RUNTIME_SECONDS,
        }
      : {}),
    steps,
  });

  if (options.drain) {
    await runDrainWorkflow({ options, projectSlug, run, steps });
  } else {
    for (const step of steps) {
      await executeWorkflowStep({ options, projectSlug, run, step });
    }
  }

  logEvent(run, { event: 'workflow_completed', llm: noLlmUsage() });
}

async function retryCommand(options: WorkflowOptions): Promise<void> {
  const projectSlug = requiredOption(options.project, '--project');
  if (!options.failedOnly) {
    throw new Error('--failed-only is required for ingest:retry.');
  }

  const run = createRunLogger({ command: 'retry', projectSlug, sourceType: options.source });
  const reset = options.dryRun
    ? { planned: true, queueItems: 0, rawDocuments: 0 }
    : await withSql(async (sql: postgres.Sql): Promise<ResetFailedQueueResult> => {
        await ensureIngestionQueueLeaseColumn(sql);
        return resetFailedQueue({ projectSlug, sourceType: options.source, sql });
      });
  logEvent(run, {
    event: 'failed_queue_reset',
    llm: noLlmUsage(),
    reset,
  });

  const steps = selectSteps({ ...options, resumeFrom: options.resumeFrom ?? 'parse' });
  validateDrainOptions(options, steps);
  logEvent(run, {
    drain: options.drain ?? false,
    dryRun: options.dryRun ?? false,
    embeddingProvider: options.embeddingProvider ?? 'deterministic',
    event: 'workflow_started',
    llm: noLlmUsage(),
    ...(options.drain
      ? {
          maxBatches: options.maxBatches ?? DEFAULT_DRAIN_MAX_BATCHES,
          maxRuntimeSeconds: options.maxRuntimeSeconds ?? DEFAULT_DRAIN_MAX_RUNTIME_SECONDS,
        }
      : {}),
    steps,
  });

  if (options.drain) {
    await runDrainWorkflow({ options, projectSlug, run, steps });
  } else {
    for (const step of steps) {
      await executeWorkflowStep({ options, projectSlug, run, step });
    }
  }

  logEvent(run, { event: 'workflow_completed', llm: noLlmUsage() });
}

async function withSql<T>(callback: (sql: postgres.Sql) => Promise<T> | T): Promise<T> {
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  try {
    return await callback(sql);
  } finally {
    await sql.end();
  }
}

async function statusCommand(options: WorkflowOptions): Promise<void> {
  const projectSlug = requiredOption(options.project, '--project');
  await withSql(async (sql: postgres.Sql): Promise<void> => {
    const project = await lookupProject(sql, projectSlug);
    if (!project) {
      throw new Error(`Project not found: ${projectSlug}`);
    }

    const status = {
      documentsByType: await countBy(sql, 'documents', 'doc_type', project.id),
      failedQueue: await listFailedQueue(sql, project.id),
      ingestionQueueByStatus: await countBy(sql, 'ingestion_queue', 'status', project.id),
      project: { id: project.id, slug: project.slug },
      rawDocumentsByStatus: await countBy(sql, 'raw_documents', 'ingest_status', project.id),
      totals: await readTotals(sql, project.id),
    };
    console.log(JSON.stringify(status, null, 2));
  });
}

async function executeWorkflowStep(input: {
  options: WorkflowOptions;
  projectSlug: string;
  run: RunLogger;
  step: WorkflowStep;
}): Promise<StepExecutionResult> {
  const startedAt = new Date();
  const command = buildStepCommand(input.step, input.projectSlug, input.options);
  logEvent(input.run, {
    argv: redactArgv(command.args),
    event: 'step_started',
    llm: noLlmUsage(),
    step: input.step,
  });

  if (input.options.dryRun) {
    const result = { planned: true };
    logEvent(input.run, {
      durationMs: Date.now() - startedAt.getTime(),
      event: 'step_completed',
      llm: noLlmUsage(),
      progressCount: 0,
      result,
      step: input.step,
    });
    return { progressCount: 0, result };
  }

  try {
    const childResult = await runNodeScript(command.args);
    const failureCount = childResult.failureCount ?? 0;
    const progressCount = measureStepProgress(input.step, childResult);
    logEvent(input.run, {
      durationMs: Date.now() - startedAt.getTime(),
      event: 'step_completed',
      llm: childResult.llm ?? noLlmUsage(),
      progressCount,
      result: childResult,
      step: input.step,
    });
    if (input.step === 'collect' && failureCount > 0) {
      const failureThreshold = collectionFailureThreshold();
      if (failureCount <= failureThreshold) {
        return { progressCount, result: childResult };
      }
      throw new Error(
        `Collection step reported ${failureCount} failed candidate(s), threshold is ${failureThreshold}.`,
      );
    }
    return { progressCount, result: childResult };
  } catch (error) {
    logEvent(input.run, {
      durationMs: Date.now() - startedAt.getTime(),
      error: safeErrorMessage(error instanceof Error ? error.message : String(error)),
      event: 'step_failed',
      llm: noLlmUsage(),
      step: input.step,
    });
    throw error;
  }
}

async function runDrainWorkflow(input: {
  options: WorkflowOptions;
  projectSlug: string;
  run: RunLogger;
  steps: WorkflowStep[];
}): Promise<void> {
  const maxBatches = input.options.maxBatches ?? DEFAULT_DRAIN_MAX_BATCHES;
  const maxRuntimeSeconds = input.options.maxRuntimeSeconds ?? DEFAULT_DRAIN_MAX_RUNTIME_SECONDS;
  const scope = drainScopeFromOptions(input.options);
  const startedAt = Date.now();

  logEvent(input.run, {
    event: 'drain_started',
    llm: noLlmUsage(),
    maxBatches,
    maxRuntimeSeconds,
    scope: summarizeDrainScope(scope),
    steps: input.steps,
  });

  if (input.options.dryRun) {
    await runDrainBatch({
      batchNumber: 1,
      options: input.options,
      projectSlug: input.projectSlug,
      run: input.run,
      steps: input.steps,
    });
    logEvent(input.run, {
      batchCount: 1,
      event: 'drain_completed',
      llm: noLlmUsage(),
      scope: summarizeDrainScope(scope),
      stopReason: 'dry_run',
    });
    return;
  }

  await withSql(async (sql: postgres.Sql): Promise<void> => {
    const project = await lookupProject(sql, input.projectSlug);
    if (!project) {
      throw new Error(`Project not found: ${input.projectSlug}`);
    }

    let completedBatches = 0;
    let lastBatchProgress: number | undefined;
    let remaining = await readDrainRemainingState(sql, project.id, input.steps, scope);
    for (let batchNumber = 1; batchNumber <= maxBatches; batchNumber += 1) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      if (elapsedSeconds >= maxRuntimeSeconds) {
        logDrainCompleted(input.run, {
          batchCount: completedBatches,
          remaining,
          scope,
          stopReason: 'max_runtime',
        });
        return;
      }

      const canProbeGraphBacklog =
        hasGraphStep(input.steps) && (completedBatches === 0 || (lastBatchProgress ?? 0) > 0);
      if (!hasDrainRemainingWork(input.steps, remaining) && !canProbeGraphBacklog) {
        logDrainCompleted(input.run, {
          batchCount: completedBatches,
          remaining,
          scope,
          stopReason: 'queue_empty',
        });
        return;
      }

      logEvent(input.run, {
        batchNumber,
        elapsedSeconds: Math.floor(elapsedSeconds),
        event: 'drain_batch_started',
        llm: noLlmUsage(),
        remaining,
        scope: summarizeDrainScope(scope),
        steps: input.steps,
      });

      const batchProgress = await runDrainBatch({
        batchNumber,
        options: input.options,
        projectSlug: input.projectSlug,
        run: input.run,
        steps: input.steps,
      });
      completedBatches = batchNumber;
      lastBatchProgress = batchProgress;
      remaining = await readDrainRemainingState(sql, project.id, input.steps, scope);
      logEvent(input.run, {
        batchNumber,
        batchProgress,
        event: 'drain_batch_completed',
        llm: noLlmUsage(),
        remaining,
        scope: summarizeDrainScope(scope),
        steps: input.steps,
      });

      if (batchProgress === 0) {
        logDrainCompleted(input.run, {
          batchCount: completedBatches,
          remaining,
          scope,
          stopReason: 'no_progress',
        });
        return;
      }
      if (!shouldContinueDrainAfterBatch({ batchProgress, remaining, steps: input.steps })) {
        logDrainCompleted(input.run, {
          batchCount: completedBatches,
          remaining,
          scope,
          stopReason: 'queue_empty',
        });
        return;
      }
    }

    logDrainCompleted(input.run, {
      batchCount: completedBatches,
      remaining,
      scope,
      stopReason: 'max_batches',
    });
  });
}

async function runDrainBatch(input: {
  batchNumber: number;
  options: WorkflowOptions;
  projectSlug: string;
  run: RunLogger;
  steps: WorkflowStep[];
}): Promise<number> {
  let batchProgress = 0;
  for (const step of input.steps) {
    const stepResult = await executeWorkflowStep({
      options: input.options,
      projectSlug: input.projectSlug,
      run: input.run,
      step,
    });
    batchProgress += stepResult.progressCount;
  }
  return batchProgress;
}

function logDrainCompleted(
  run: RunLogger,
  input: {
    batchCount: number;
    remaining: DrainRemainingState;
    scope: DrainScope;
    stopReason: DrainStopReason;
  },
): void {
  logEvent(run, {
    batchCount: input.batchCount,
    event: 'drain_completed',
    llm: noLlmUsage(),
    remaining: summarizeDrainRemaining(input.remaining),
    scope: summarizeDrainScope(input.scope),
    stopReason: input.stopReason,
  });
}

function validateDrainOptions(options: WorkflowOptions, steps: WorkflowStep[]): void {
  if (!options.drain) {
    return;
  }
  if (steps.includes('collect')) {
    throw new Error(
      '--drain cannot be used when collect is included. Use --resume-from parse or --step parse|chunk|graph.',
    );
  }
  if (steps.length === 1 && steps[0] === 'resolve') {
    throw new Error(
      '--drain cannot be used with --step resolve alone. Use --resume-from resolve or include chunk/graph in the selected steps.',
    );
  }
}

function drainScopeFromOptions(options: WorkflowOptions): DrainScope {
  return {
    dataSourceId: options.dataSourceId,
    sourceType: options.source,
  };
}

function summarizeDrainScope(scope: DrainScope): Record<string, string | null> {
  return {
    dataSourceId: scope.dataSourceId ?? null,
    source: scope.sourceType ?? null,
  };
}

async function readDrainRemainingState(
  sql: postgres.Sql,
  projectId: string,
  steps: WorkflowStep[],
  scope: DrainScope,
): Promise<DrainRemainingState> {
  const [parseQueue, parsedRaw] = await Promise.all([
    steps.includes('parse') ? countParseQueueRemaining(sql, projectId, scope) : Promise.resolve(0),
    shouldCountParsedRaw(steps)
      ? countParsedRawRemaining(sql, projectId, scope)
      : Promise.resolve(0),
  ]);
  return summarizeDrainRemaining({ parseQueue, parsedRaw });
}

async function countParseQueueRemaining(
  sql: postgres.Sql,
  projectId: string,
  scope: DrainScope,
): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.ingestion_queue q
    JOIN public.raw_documents rd ON rd.id = q.raw_document_id
    WHERE q.project_id = ${projectId}
      AND (
        q.status = 'pending'
        OR (q.status = 'parsing' AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= now()))
      )
      AND rd.ingest_status = 'fetched'
      AND (${scope.sourceType ?? null}::text IS NULL OR rd.source_type = ${scope.sourceType ?? null})
      AND (${scope.dataSourceId ?? null}::uuid IS NULL OR q.data_source_id = ${scope.dataSourceId ?? null}::uuid)
  `) as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

async function countParsedRawRemaining(
  sql: postgres.Sql,
  projectId: string,
  scope: DrainScope,
): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS count
    FROM public.raw_documents rd
    WHERE rd.project_id = ${projectId}
      AND rd.ingest_status = 'parsed'
      AND rd.parsed_uri IS NOT NULL
      AND (${scope.sourceType ?? null}::text IS NULL OR rd.source_type = ${scope.sourceType ?? null})
      AND (
        ${scope.dataSourceId ?? null}::uuid IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.raw_document_data_sources rdds
          WHERE rdds.raw_document_id = rd.id
            AND rdds.data_source_id = ${scope.dataSourceId ?? null}::uuid
        )
      )
  `) as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

function measureStepProgress(step: WorkflowStep, result: ScriptResult): number {
  const decisions = Array.isArray(result.decisions) ? result.decisions : [];
  if (decisions.length > 0) {
    if (step === 'resolve') {
      return decisions.length;
    }
    return decisions.filter((decision) => countsAsDrainProgress(step, decision)).length;
  }
  if (typeof result.decisionCount === 'number') {
    return result.decisionCount;
  }
  return 0;
}

function countsAsDrainProgress(step: WorkflowStep, decision: unknown): boolean {
  if (!decision || typeof decision !== 'object') {
    return false;
  }
  const record = decision as Record<string, unknown>;
  const value = record.decision;
  if (step === 'parse') {
    return value === 'parsed' || value === 'held' || value === 'failed';
  }
  if (step === 'chunk') {
    return value === 'indexed' || value === 'unchanged' || value === 'failed';
  }
  if (step === 'graph') {
    return value === 'indexed' || value === 'failed';
  }
  return true;
}

function buildStepCommand(
  step: WorkflowStep,
  projectSlug: string,
  options: WorkflowOptions,
): StepCommand {
  const args: string[] = [];
  if (step === 'collect') {
    if (options.fixture) {
      args.push(join(repoRoot, 'scripts/collect-fixture-source.ts'), '--project', projectSlug);
      if (options.source) {
        args.push('--source', options.source);
      }
    } else {
      const sourceType = requiredOption(options.source, '--source');
      args.push(
        join(repoRoot, 'scripts/collect-source.ts'),
        '--project',
        projectSlug,
        '--source',
        sourceType,
      );
      for (const url of options.urls ?? []) {
        args.push('--url', url);
      }
      for (const repository of options.repositories ?? []) {
        args.push('--repo', repository);
      }
      for (const folderId of options.folderIds ?? []) {
        args.push('--folder-id', folderId);
      }
      for (const folderUrl of options.folderUrls ?? []) {
        args.push('--folder-url', folderUrl);
      }
      for (const labelId of options.labelIds ?? []) {
        args.push('--label-id', labelId);
      }
      if (options.query) {
        args.push('--query', options.query);
      }
      if (options.state) {
        args.push('--state', options.state);
      }
      appendLimit(args, options.limit);
    }
    return { args };
  }
  if (step === 'parse') {
    args.push(join(repoRoot, 'scripts/parse-raw-documents.ts'), '--project', projectSlug);
    if (options.source) {
      args.push('--source', options.source);
    }
    appendDataSourceId(args, options.dataSourceId);
    appendLimit(args, options.limit);
    return { args };
  }
  if (step === 'resolve') {
    args.push(join(repoRoot, 'scripts/resolve-actors.ts'), '--project', projectSlug);
    if (options.source) {
      args.push('--source', options.source);
    }
    appendDataSourceId(args, options.dataSourceId);
    appendLimit(args, options.limit);
    return { args };
  }
  if (step === 'chunk') {
    args.push(join(repoRoot, 'scripts/chunk-and-embed.ts'), '--project', projectSlug);
    if (options.source) {
      args.push('--source', options.source);
    }
    appendDataSourceId(args, options.dataSourceId);
    appendLimit(args, options.limit);
    args.push('--embedding-provider', options.embeddingProvider ?? 'deterministic');
    return { args };
  }
  if (step === 'graph') {
    args.push(join(repoRoot, 'scripts/index-graph-relations.ts'), '--project', projectSlug);
    if (options.source) {
      args.push('--source', options.source);
    }
    appendDataSourceId(args, options.dataSourceId);
    appendLimit(args, options.limit);
    return { args };
  }
  throw new Error(`Unknown workflow step: ${step}`);
}

function appendLimit(args: string[], limit: number | undefined): void {
  if (limit !== undefined) {
    args.push('--limit', String(limit));
  }
}

function appendDataSourceId(args: string[], dataSourceId: string | undefined): void {
  if (dataSourceId !== undefined) {
    args.push('--data-source-id', dataSourceId);
  }
}

async function runNodeScript(args: string[]): Promise<ScriptResult> {
  const child = spawn(process.execPath, [...process.execArgv, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string): void => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string): void => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  if (exitCode !== 0) {
    throw new Error(safeErrorMessage(stderr || stdout || `script exited with ${exitCode}`));
  }

  return parseScriptOutput(stdout);
}

function parseScriptOutput(stdout: string): ScriptResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  for (const line of trimmed.split('\n').reverse()) {
    const jsonCandidate = line.trim();
    if (!jsonCandidate.startsWith('{') || !jsonCandidate.endsWith('}')) {
      continue;
    }
    try {
      return summarizeScriptResult(JSON.parse(jsonCandidate));
    } catch {
      // Continue scanning earlier lines.
    }
  }

  for (
    let index = trimmed.lastIndexOf('{');
    index >= 0;
    index = trimmed.lastIndexOf('{', index - 1)
  ) {
    try {
      return summarizeScriptResult(JSON.parse(trimmed.slice(index)));
    } catch {
      // Continue scanning earlier JSON object starts.
    }
  }

  try {
    return summarizeScriptResult(JSON.parse(trimmed));
  } catch {
    return { output: safeErrorMessage(trimmed) };
  }
}

function summarizeScriptResult(result: unknown): ScriptResult {
  if (!result || typeof result !== 'object') {
    return {};
  }

  const record = result as Record<string, unknown>;
  const decisions = Array.isArray(record.decisions)
    ? record.decisions.map(summarizeDecision)
    : undefined;
  return {
    ...(typeof record.projectSlug === 'string' ? { projectSlug: record.projectSlug } : {}),
    ...(typeof record.embeddingModel === 'string' ? { embeddingModel: record.embeddingModel } : {}),
    ...(typeof record.failureCount === 'number' ? { failureCount: record.failureCount } : {}),
    ...(isLlmUsage(record.llm) ? { llm: record.llm } : {}),
    ...(decisions ? { decisionCount: decisions.length, decisions } : {}),
  };
}

function summarizeDecision(decision: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (!decision || typeof decision !== 'object') {
    return summary;
  }
  const record = decision as Record<string, unknown>;
  for (const key of [
    'actorEdgeCount',
    'chunkCount',
    'dataSourceId',
    'decision',
    'documentId',
    'emailQuoteCount',
    'error',
    'graphEdgeCount',
    'graphNodeCount',
    'rawDocumentId',
    'sameAsCount',
    'sourceId',
    'sourceType',
  ]) {
    if (record[key] !== undefined) {
      summary[key] = record[key];
    }
  }
  return summary;
}

async function resetFailedQueue(input: {
  projectSlug: string;
  sourceType?: SourceType;
  sql: postgres.Sql;
}): Promise<ResetFailedQueueResult> {
  const project = await lookupProject(input.sql, input.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${input.projectSlug}`);
  }

  const rows = (await input.sql`
    WITH expired_parsing AS (
      SELECT q.id AS queue_id, rd.id AS raw_document_id, rd.parsed_uri
      FROM public.ingestion_queue q
      JOIN public.raw_documents rd ON rd.id = q.raw_document_id
      WHERE q.project_id = ${project.id}
        AND q.status = 'parsing'
        AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= now())
        AND rd.ingest_status IN ('fetched', 'failed')
        AND (${input.sourceType ?? null}::text IS NULL OR rd.source_type = ${input.sourceType ?? null})
    ),
    failed AS (
      SELECT q.id AS queue_id, rd.id AS raw_document_id, rd.parsed_uri
      FROM public.ingestion_queue q
      JOIN public.raw_documents rd ON rd.id = q.raw_document_id
      WHERE q.project_id = ${project.id}
        AND q.status = 'failed'
        AND rd.ingest_status = 'failed'
        AND (${input.sourceType ?? null}::text IS NULL OR rd.source_type = ${input.sourceType ?? null})
    ),
    resettable AS (
      SELECT * FROM failed
      UNION ALL
      SELECT * FROM expired_parsing
    ),
    updated_raw AS (
      UPDATE public.raw_documents rd
      SET
        ingest_status = CASE WHEN resettable.parsed_uri IS NULL THEN 'fetched' ELSE 'parsed' END,
        ingest_error = null,
        hold_reason = null
      FROM resettable
      WHERE rd.id = resettable.raw_document_id
      RETURNING rd.id
    ),
    updated_queue AS (
      UPDATE public.ingestion_queue q
      SET
        status = 'pending',
        last_error = null,
        hold_reason = null,
        lease_expires_at = null,
        scheduled_at = now()
      FROM resettable
      WHERE q.id = resettable.queue_id
      RETURNING q.id
    )
    SELECT
      (SELECT count(*)::int FROM updated_raw) AS "rawDocuments",
      (SELECT count(*)::int FROM updated_queue) AS "queueItems"
  `) as ResetFailedQueueResult[];

  return rows[0] ?? { queueItems: 0, rawDocuments: 0 };
}

async function lookupProject(sql: postgres.Sql, slug: string): Promise<ProjectRecord | undefined> {
  const rows = await sql`
    SELECT id::text AS id, slug
    FROM public.projects
    WHERE slug = ${slug}
  `;
  return rows[0] as ProjectRecord | undefined;
}

async function countBy(
  sql: postgres.Sql,
  tableName: string,
  columnName: string,
  projectId: string,
): Promise<Record<string, number>> {
  const rows = await selectCountRows(sql, tableName, columnName, projectId);
  return Object.fromEntries(rows.map((row) => [row.name, row.count]));
}

async function selectCountRows(
  sql: postgres.Sql,
  tableName: string,
  columnName: string,
  projectId: string,
): Promise<CountRow[]> {
  if (tableName === 'documents' && columnName === 'doc_type') {
    return sql`
      SELECT doc_type AS name, count(*)::int AS count
      FROM public.documents
      WHERE project_id = ${projectId}
      GROUP BY doc_type
      ORDER BY doc_type
    `;
  }
  if (tableName === 'ingestion_queue' && columnName === 'status') {
    return sql`
      SELECT status AS name, count(*)::int AS count
      FROM public.ingestion_queue
      WHERE project_id = ${projectId}
      GROUP BY status
      ORDER BY status
    `;
  }
  if (tableName === 'raw_documents' && columnName === 'ingest_status') {
    return sql`
      SELECT ingest_status AS name, count(*)::int AS count
      FROM public.raw_documents
      WHERE project_id = ${projectId}
      GROUP BY ingest_status
      ORDER BY ingest_status
    `;
  }
  throw new Error(`Unsupported status count: ${tableName}.${columnName}`);
}

async function readTotals(sql: postgres.Sql, projectId: string): Promise<Totals | undefined> {
  const rows = await sql`
    SELECT
      (SELECT count(*)::int FROM public.raw_documents WHERE project_id = ${projectId}) AS "rawDocuments",
      (SELECT count(*)::int FROM public.ingestion_queue WHERE project_id = ${projectId}) AS "queueItems",
      (SELECT count(*)::int FROM public.documents WHERE project_id = ${projectId}) AS documents,
      (SELECT count(*)::int FROM public.document_chunks WHERE project_id = ${projectId}) AS "documentChunks",
      (SELECT count(*)::int FROM public.email_quotes WHERE project_id = ${projectId}) AS "emailQuotes"
  `;
  return rows[0] as Totals | undefined;
}

async function listFailedQueue(sql: postgres.Sql, projectId: string): Promise<FailedQueueItem[]> {
  return (await sql`
    SELECT
      q.attempts,
      q.hold_reason AS "holdReason",
      left(q.last_error, 200) AS "lastError",
      rd.source_id AS "sourceId",
      rd.source_type AS "sourceType",
      q.status
    FROM public.ingestion_queue q
    JOIN public.raw_documents rd ON rd.id = q.raw_document_id
    WHERE q.project_id = ${projectId}
      AND q.status IN ('failed', 'held')
    ORDER BY q.updated_at DESC, q.created_at DESC
    LIMIT 20
  `) as FailedQueueItem[];
}

function selectSteps(options: { resumeFrom?: WorkflowStep; step?: WorkflowStep }): WorkflowStep[] {
  if (options.step && options.resumeFrom) {
    throw new Error('Cannot specify both --step and --resume-from.');
  }
  if (options.step) {
    return [options.step];
  }

  const startIndex = options.resumeFrom ? STEP_ORDER.indexOf(options.resumeFrom) : 0;
  if (startIndex < 0) {
    throw new Error(`Unknown --resume-from value: ${options.resumeFrom}`);
  }
  return STEP_ORDER.slice(startIndex);
}

function createRunLogger(input: {
  command: WorkflowCommand;
  projectSlug: string;
  sourceType?: SourceType;
}): RunLogger {
  return {
    command: input.command,
    projectSlug: input.projectSlug,
    runId: `ingest-${randomUUID()}`,
    sourceType: input.sourceType,
  };
}

function logEvent(run: RunLogger, event: WorkflowEvent): void {
  console.log(
    JSON.stringify({
      command: run.command,
      project: run.projectSlug,
      runId: run.runId,
      source: run.sourceType ?? null,
      timestamp: new Date().toISOString(),
      ...event,
    }),
  );
}

function noLlmUsage(): LlmUsage {
  return {
    agentCalls: 0,
    chatModelCalls: 0,
    embeddingModelCalls: 0,
    tokenUsage: 0,
  };
}

function isLlmUsage(value: unknown): value is LlmUsage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.agentCalls === 'number' &&
    typeof record.chatModelCalls === 'number' &&
    typeof record.embeddingModelCalls === 'number' &&
    typeof record.tokenUsage === 'number'
  );
}

function parseArgs(argv: string[]): WorkflowOptions {
  const options: WorkflowOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--data-source-id') {
      options.dataSourceId = readOptionValue(argv, ++index, arg);
    } else if (arg === '--source') {
      options.source = readSourceType(readOptionValue(argv, ++index, arg));
    } else if (arg === '--fixture') {
      options.fixture = true;
    } else if (arg === '--url') {
      options.urls = options.urls ?? [];
      options.urls.push(readOptionValue(argv, ++index, arg));
    } else if (arg === '--repo' || arg === '--repository') {
      options.repositories = options.repositories ?? [];
      options.repositories.push(readRepository(readOptionValue(argv, ++index, arg), arg));
    } else if (arg === '--folder-id') {
      options.folderIds = options.folderIds ?? [];
      options.folderIds.push(readDriveFolderId(readOptionValue(argv, ++index, arg), arg));
    } else if (arg === '--folder-url') {
      options.folderUrls = options.folderUrls ?? [];
      options.folderUrls.push(readOptionValue(argv, ++index, arg));
    } else if (arg === '--label' || arg === '--label-id') {
      options.labelIds = options.labelIds ?? [];
      options.labelIds.push(readGmailLabelId(readOptionValue(argv, ++index, arg), arg));
    } else if (arg === '--query' || arg === '--gmail-query') {
      options.query = readOptionValue(argv, ++index, arg);
    } else if (arg === '--state') {
      options.state = readGitHubState(readOptionValue(argv, ++index, arg), arg);
    } else if (arg === '--failed-only') {
      options.failedOnly = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--drain') {
      options.drain = true;
    } else if (arg === '--max-batches') {
      options.maxBatches = readPositiveInteger(readOptionValue(argv, ++index, arg), arg);
    } else if (arg === '--max-runtime-seconds') {
      options.maxRuntimeSeconds = readPositiveInteger(readOptionValue(argv, ++index, arg), arg);
    } else if (arg === '--limit') {
      options.limit = readPositiveInteger(readOptionValue(argv, ++index, arg), arg);
    } else if (arg === '--embedding-provider') {
      options.embeddingProvider = readOptionValue(argv, ++index, arg);
    } else if (arg === '--resume-from') {
      options.resumeFrom = readStepOption(readOptionValue(argv, ++index, arg), arg);
    } else if (arg === '--step') {
      options.step = readStepOption(readOptionValue(argv, ++index, arg), arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readSourceType(value: string): SourceType {
  if (!(SOURCE_TYPES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported --source value: ${value}`);
  }
  return value as SourceType;
}

function readDriveFolderId(value: string, optionName: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${optionName} must be a Google Drive folder id: ${value}`);
  }
  return value;
}

function readGmailLabelId(value: string, optionName: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${optionName} must be a non-empty string.`);
  }
  return value;
}

function readGitHubState(value: string, optionName: string): 'all' | 'closed' | 'open' {
  if (value !== 'all' && value !== 'closed' && value !== 'open') {
    throw new Error(`Invalid ${optionName} value: ${value}`);
  }
  return value;
}

function readRepository(value: string, optionName: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`${optionName} must be owner/repo: ${value}`);
  }
  return value;
}

function readStepOption(value: string, optionName: string): WorkflowStep {
  if (!(STEP_ORDER as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${optionName} value: ${value}`);
  }
  return value as WorkflowStep;
}

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function readPositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
}

function redactArgv(args: string[]): string[] {
  return args.map((arg: string): string =>
    arg.includes(process.cwd()) ? arg.replace(process.cwd(), '.') : arg,
  );
}

function safeErrorMessage(value: unknown): string {
  return String(value)
    .replace(/(token|secret|api[_-]?key)=\S+/gi, '$1=<redacted>')
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/gi, '$1<redacted>@')
    .slice(0, 1000);
}

function collectionFailureThreshold(): number {
  const value = process.env.PUFU_LENS_INGEST_FAILURE_THRESHOLD;
  if (value === undefined || value.trim() === '') {
    return 0;
  }
  return readNonNegativeInteger(value, 'PUFU_LENS_INGEST_FAILURE_THRESHOLD');
}

function readNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
}

function requiredOption<T extends string>(value: T | undefined, name: string): T {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
