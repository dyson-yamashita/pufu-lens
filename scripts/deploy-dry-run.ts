import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

type DryRunResult = {
  checkId: string;
  status: 'failed' | 'passed';
};

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
  {
    input: {},
    workflowId: 'source-sync-dispatcher',
  },
] as const;

async function main(): Promise<void> {
  const results: DryRunResult[] = [await runMigrationCheck()];
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

async function runMigrationCheck(): Promise<DryRunResult> {
  try {
    const exitCode = await runCommand(
      process.execPath,
      [...process.execArgv, 'scripts/db-migrate.ts', '--check'],
      {
        DATABASE_URL: '',
      },
    );

    return { checkId: 'db:migrate --check', status: exitCode === 0 ? 'passed' : 'failed' };
  } catch (error) {
    process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return { checkId: 'db:migrate --check', status: 'failed' };
  }
}

async function runWorkflowDryRun(
  workflowId: string,
  input: Record<string, unknown>,
): Promise<DryRunResult> {
  try {
    const exitCode = await runCommand(
      process.execPath,
      [...process.execArgv, 'scripts/workflow-job.ts'],
      {
        DRY_RUN: 'true',
        WORKFLOW_ID: workflowId,
        WORKFLOW_INPUT_JSON: JSON.stringify(input),
      },
    );

    if (exitCode !== 0) {
      return { checkId: `workflow:${workflowId}`, status: 'failed' };
    }
    return { checkId: `workflow:${workflowId}`, status: 'passed' };
  } catch (error) {
    process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return { checkId: `workflow:${workflowId}`, status: 'failed' };
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<number | null> {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
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
  }

  return exitCode;
}

main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
