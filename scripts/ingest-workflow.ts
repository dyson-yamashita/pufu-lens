import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const SOURCE_TYPES = ['github', 'web', 'gmail', 'drive'];
const STEP_ORDER = ['collect', 'parse', 'resolve', 'chunk', 'graph'];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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

async function runCommand(options: any): Promise<any> {
  const projectSlug = requiredOption(options.project, '--project');
  if (!options.fixture && options.source !== 'web') {
    throw new Error('--fixture is required unless --source web is used.');
  }

  const run = createRunLogger({ command: 'run', projectSlug, sourceType: options.source });
  const steps = selectSteps(options);
  logEvent(run, {
    dryRun: options.dryRun ?? false,
    embeddingProvider: options.embeddingProvider ?? 'deterministic',
    event: 'workflow_started',
    llm: noLlmUsage(),
    steps,
  });

  for (const step of steps) {
    await executeWorkflowStep({ options, projectSlug, run, step });
  }

  logEvent(run, { event: 'workflow_completed', llm: noLlmUsage() });
}

async function retryCommand(options: any): Promise<any> {
  const projectSlug = requiredOption(options.project, '--project');
  if (!options.failedOnly) {
    throw new Error('--failed-only is required for ingest:retry.');
  }

  const run = createRunLogger({ command: 'retry', projectSlug, sourceType: options.source });
  const reset = options.dryRun
    ? { planned: true, queueItems: 0, rawDocuments: 0 }
    : await withSql((sql: postgres.Sql): any =>
        resetFailedQueue({ projectSlug, sourceType: options.source, sql }),
      );
  logEvent(run, {
    event: 'failed_queue_reset',
    llm: noLlmUsage(),
    reset,
  });

  const steps = selectSteps({ ...options, resumeFrom: options.resumeFrom ?? 'parse' });
  logEvent(run, {
    dryRun: options.dryRun ?? false,
    embeddingProvider: options.embeddingProvider ?? 'deterministic',
    event: 'workflow_started',
    llm: noLlmUsage(),
    steps,
  });

  for (const step of steps) {
    await executeWorkflowStep({ options, projectSlug, run, step });
  }

  logEvent(run, { event: 'workflow_completed', llm: noLlmUsage() });
}

async function withSql(callback: any): Promise<any> {
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });
  try {
    return await callback(sql);
  } finally {
    await sql.end();
  }
}

async function statusCommand(options: any): Promise<any> {
  const projectSlug = requiredOption(options.project, '--project');
  await withSql(async (sql: postgres.Sql): Promise<any> => {
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

async function executeWorkflowStep(input: any): Promise<any> {
  const startedAt = new Date();
  const command = buildStepCommand(input.step, input.projectSlug, input.options);
  logEvent(input.run, {
    argv: redactArgv(command.args),
    event: 'step_started',
    llm: noLlmUsage(),
    step: input.step,
  });

  if (input.options.dryRun) {
    logEvent(input.run, {
      durationMs: Date.now() - startedAt.getTime(),
      event: 'step_completed',
      llm: noLlmUsage(),
      result: { planned: true },
      step: input.step,
    });
    return;
  }

  try {
    const childResult = await runNodeScript(command.args);
    logEvent(input.run, {
      durationMs: Date.now() - startedAt.getTime(),
      event: 'step_completed',
      llm: childResult.llm ?? noLlmUsage(),
      result: childResult,
      step: input.step,
    });
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

function buildStepCommand(step: any, projectSlug: any, options: any): any {
  const args = [];
  if (step === 'collect') {
    if (options.fixture) {
      args.push(join(repoRoot, 'scripts/collect-fixture-source.ts'), '--project', projectSlug);
      if (options.source) {
        args.push('--source', options.source);
      }
    } else {
      args.push(
        join(repoRoot, 'scripts/collect-source.ts'),
        '--project',
        projectSlug,
        '--source',
        options.source,
      );
      for (const url of options.urls ?? []) {
        args.push('--url', url);
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
    appendLimit(args, options.limit);
    return { args };
  }
  if (step === 'resolve') {
    args.push(join(repoRoot, 'scripts/resolve-actors.ts'), '--project', projectSlug);
    if (options.source) {
      args.push('--source', options.source);
    }
    appendLimit(args, options.limit);
    return { args };
  }
  if (step === 'chunk') {
    args.push(join(repoRoot, 'scripts/chunk-and-embed.ts'), '--project', projectSlug);
    if (options.source) {
      args.push('--source', options.source);
    }
    appendLimit(args, options.limit);
    args.push('--embedding-provider', options.embeddingProvider ?? 'deterministic');
    return { args };
  }
  if (step === 'graph') {
    args.push(join(repoRoot, 'scripts/index-graph-relations.ts'), '--project', projectSlug);
    if (options.source) {
      args.push('--source', options.source);
    }
    appendLimit(args, options.limit);
    return { args };
  }
  throw new Error(`Unknown workflow step: ${step}`);
}

function appendLimit(args: any, limit: any): any {
  if (limit !== undefined) {
    args.push('--limit', String(limit));
  }
}

async function runNodeScript(args: any): Promise<any> {
  const child = spawn(process.execPath, [...process.execArgv, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: any): any => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: any): any => {
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

function parseScriptOutput(stdout: any): any {
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

function summarizeScriptResult(result: any): any {
  if (!result || typeof result !== 'object') {
    return {};
  }

  const decisions = Array.isArray(result.decisions)
    ? result.decisions.map(summarizeDecision)
    : undefined;
  return {
    ...(result.projectSlug ? { projectSlug: result.projectSlug } : {}),
    ...(result.embeddingModel ? { embeddingModel: result.embeddingModel } : {}),
    ...(result.llm ? { llm: result.llm } : {}),
    ...(decisions ? { decisionCount: decisions.length, decisions } : {}),
  };
}

function summarizeDecision(decision: any): any {
  const summary: any = {};
  for (const key of [
    'actorEdgeCount',
    'chunkCount',
    'dataSourceId',
    'decision',
    'documentId',
    'emailQuoteCount',
    'graphEdgeCount',
    'graphNodeCount',
    'rawDocumentId',
    'sameAsCount',
    'sourceId',
    'sourceType',
  ]) {
    if (decision[key] !== undefined) {
      summary[key] = decision[key];
    }
  }
  return summary;
}

async function resetFailedQueue(input: any): Promise<any> {
  const project = await lookupProject(input.sql, input.projectSlug);
  if (!project) {
    throw new Error(`Project not found: ${input.projectSlug}`);
  }

  const rows = await input.sql`
    WITH failed AS (
      SELECT q.id AS queue_id, rd.id AS raw_document_id, rd.parsed_uri
      FROM public.ingestion_queue q
      JOIN public.raw_documents rd ON rd.id = q.raw_document_id
      WHERE q.project_id = ${project.id}
        AND q.status = 'failed'
        AND rd.ingest_status = 'failed'
        AND (${input.sourceType ?? null}::text IS NULL OR rd.source_type = ${input.sourceType ?? null})
    ),
    updated_raw AS (
      UPDATE public.raw_documents rd
      SET
        ingest_status = CASE WHEN failed.parsed_uri IS NULL THEN 'fetched' ELSE 'parsed' END,
        ingest_error = null,
        hold_reason = null
      FROM failed
      WHERE rd.id = failed.raw_document_id
      RETURNING rd.id
    ),
    updated_queue AS (
      UPDATE public.ingestion_queue q
      SET
        status = 'pending',
        last_error = null,
        hold_reason = null,
        scheduled_at = now()
      FROM failed
      WHERE q.id = failed.queue_id
      RETURNING q.id
    )
    SELECT
      (SELECT count(*)::int FROM updated_raw) AS "rawDocuments",
      (SELECT count(*)::int FROM updated_queue) AS "queueItems"
  `;

  return rows[0] ?? { queueItems: 0, rawDocuments: 0 };
}

async function lookupProject(sql: postgres.Sql, slug: string): Promise<any> {
  const rows = await sql`
    SELECT id::text AS id, slug
    FROM public.projects
    WHERE slug = ${slug}
  `;
  return rows[0];
}

async function countBy(sql: any, tableName: any, columnName: any, projectId: any): Promise<any> {
  const rows = await selectCountRows(sql, tableName, columnName, projectId);
  return Object.fromEntries(rows.map((row: any): any => [row.name, row.count]));
}

async function selectCountRows(
  sql: any,
  tableName: any,
  columnName: any,
  projectId: any,
): Promise<any> {
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

async function readTotals(sql: any, projectId: any): Promise<any> {
  const rows = await sql`
    SELECT
      (SELECT count(*)::int FROM public.raw_documents WHERE project_id = ${projectId}) AS "rawDocuments",
      (SELECT count(*)::int FROM public.ingestion_queue WHERE project_id = ${projectId}) AS "queueItems",
      (SELECT count(*)::int FROM public.documents WHERE project_id = ${projectId}) AS documents,
      (SELECT count(*)::int FROM public.document_chunks WHERE project_id = ${projectId}) AS "documentChunks",
      (SELECT count(*)::int FROM public.email_quotes WHERE project_id = ${projectId}) AS "emailQuotes"
  `;
  return rows[0];
}

async function listFailedQueue(sql: any, projectId: any): Promise<any> {
  return sql`
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
  `;
}

function selectSteps(options: any): any {
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

function createRunLogger(input: any): any {
  return {
    command: input.command,
    projectSlug: input.projectSlug,
    runId: `ingest-${randomUUID()}`,
    sourceType: input.sourceType,
  };
}

function logEvent(run: any, event: any): any {
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

function noLlmUsage(): any {
  return {
    agentCalls: 0,
    chatModelCalls: 0,
    embeddingModelCalls: 0,
    tokenUsage: 0,
  };
}

function parseArgs(argv: string[]): any {
  const options: any = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--source') {
      const sourceType = readOptionValue(argv, ++index, arg);
      if (!SOURCE_TYPES.includes(sourceType)) {
        throw new Error(`Unsupported --source value: ${sourceType}`);
      }
      options.source = sourceType;
    } else if (arg === '--fixture') {
      options.fixture = true;
    } else if (arg === '--url') {
      options.urls = options.urls ?? [];
      options.urls.push(readOptionValue(argv, ++index, arg));
    } else if (arg === '--failed-only') {
      options.failedOnly = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
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

function readStepOption(value: string, optionName: string): string {
  if (!STEP_ORDER.includes(value)) {
    throw new Error(`Invalid ${optionName} value: ${value}`);
  }
  return value;
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredOption(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
