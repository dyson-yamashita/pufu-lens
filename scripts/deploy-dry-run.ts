import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const samples = [
  {
    input: { dryRun: true, fixture: true, limit: 1, projectSlug: 'sample-a', source: 'web' },
    workflowId: 'curate-workflow',
  },
  {
    input: { dryRun: true, fixture: true, limit: 1, projectSlug: 'sample-a', source: 'web' },
    workflowId: 'ingest-workflow',
  },
  {
    input: { dryRun: true, period: 'weekly', projectSlug: 'sample-a' },
    workflowId: 'generate-report',
  },
] as const;

async function main(): Promise<void> {
  const results = [];
  for (const sample of samples) {
    const result = await runWorkflowDryRun(sample.workflowId, sample.input);
    results.push(result);
  }
  const allPassed = results.every((result) => result.status === 'passed');

  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        mode: 'deploy_dry_run',
        results,
        status: allPassed ? 'passed' : 'failed',
      },
      null,
      2,
    ),
  );

  if (!allPassed) {
    process.exitCode = 1;
  }
}

async function runWorkflowDryRun(
  workflowId: string,
  input: Record<string, unknown>,
): Promise<{ status: 'failed' | 'passed'; workflowId: string }> {
  try {
    const child = spawn(process.execPath, [...process.execArgv, 'scripts/workflow-job.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DRY_RUN: 'true',
        WORKFLOW_ID: workflowId,
        WORKFLOW_INPUT_JSON: JSON.stringify(input),
      },
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
      process.stderr.write(stderr || stdout);
      return { status: 'failed', workflowId };
    }
    return { status: 'passed', workflowId };
  } catch (error) {
    process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return { status: 'failed', workflowId };
  }
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
