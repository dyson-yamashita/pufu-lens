import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ingestWorkflowScript = join(repoRoot, 'scripts/ingest-workflow.ts');

type ScriptRunResult = {
  exitCode: number | null;
  events: Array<Record<string, unknown>>;
  stderr: string;
};

async function runIngestWorkflow(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<ScriptRunResult> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', ingestWorkflowScript, ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        DATABASE_URL: undefined,
      },
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  return {
    exitCode,
    events: parseJsonLines(stdout),
    stderr,
  };
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventNames(events: readonly Record<string, unknown>[]): string[] {
  return events.map((event) => String(event.event));
}

test('dry-run drain logs drain lifecycle events', async () => {
  const result = await runIngestWorkflow([
    'run',
    '--project',
    'sample-a',
    '--source',
    'github',
    '--fixture',
    '--dry-run',
    '--drain',
    '--resume-from',
    'parse',
    '--limit',
    '5',
    '--max-batches',
    '3',
    '--max-runtime-seconds',
    '120',
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(eventNames(result.events), [
    'workflow_started',
    'drain_started',
    'step_started',
    'step_completed',
    'step_started',
    'step_completed',
    'step_started',
    'step_completed',
    'step_started',
    'step_completed',
    'drain_completed',
    'workflow_completed',
  ]);
  assert.equal(result.events[1]?.event, 'drain_started');
  assert.equal(result.events[1]?.maxBatches, 3);
  assert.equal(result.events[1]?.maxRuntimeSeconds, 120);
  assert.equal(result.events.at(-2)?.event, 'drain_completed');
  assert.equal(result.events.at(-2)?.stopReason, 'dry_run');
  assert.deepEqual(result.events[1]?.remaining, undefined);
});

test('dry-run drain from chunk runs only chunk step', async () => {
  const result = await runIngestWorkflow([
    'run',
    '--project',
    'sample-a',
    '--source',
    'github',
    '--fixture',
    '--dry-run',
    '--drain',
    '--step',
    'chunk',
    '--limit',
    '5',
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.events.filter((event) => event.event === 'step_completed').length, 1);
});

test('non-drain dry-run keeps single-pass behavior', async () => {
  const result = await runIngestWorkflow([
    'run',
    '--project',
    'sample-a',
    '--source',
    'github',
    '--fixture',
    '--dry-run',
    '--resume-from',
    'chunk',
    '--limit',
    '5',
  ]);

  assert.equal(result.exitCode, 0);
  assert.ok(!eventNames(result.events).includes('drain_started'));
  assert.equal(result.events.filter((event) => event.event === 'step_completed').length, 2);
});

test('drain rejects collect in selected steps', async () => {
  const result = await runIngestWorkflow([
    'run',
    '--project',
    'sample-a',
    '--source',
    'github',
    '--fixture',
    '--dry-run',
    '--drain',
  ]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--drain cannot be used when collect is included/);
});

test('drain rejects collect when --step collect is used', async () => {
  const result = await runIngestWorkflow([
    'run',
    '--project',
    'sample-a',
    '--source',
    'github',
    '--dry-run',
    '--drain',
    '--step',
    'collect',
  ]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--drain cannot be used when collect is included/);
});

test('drain rejects resolve-only step selection', async () => {
  const result = await runIngestWorkflow([
    'run',
    '--project',
    'sample-a',
    '--source',
    'github',
    '--dry-run',
    '--drain',
    '--step',
    'resolve',
  ]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--drain cannot be used with --step resolve alone/);
  assert.match(result.stderr, /--resume-from resolve or include chunk\/graph/);
});

test('rejects invalid --max-batches values', async () => {
  const result = await runIngestWorkflow([
    'run',
    '--project',
    'sample-a',
    '--source',
    'github',
    '--fixture',
    '--dry-run',
    '--drain',
    '--resume-from',
    'parse',
    '--max-batches',
    '0',
  ]);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Invalid --max-batches value/);
});
