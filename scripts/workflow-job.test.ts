import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runJsonLineScript } from './lib/script-test-runner.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowJobScript = join(repoRoot, 'scripts/workflow-job.ts');

async function runWorkflowJob(env: Record<string, string>) {
  return runJsonLineScript({
    cwd: repoRoot,
    env: { ...env, DATABASE_URL: undefined },
    scriptPath: workflowJobScript,
  });
}

test('ingest-workflow job plan passes drain options through argv', async () => {
  const result = await runWorkflowJob({
    DRY_RUN: 'true',
    WORKFLOW_ID: 'ingest-workflow',
    WORKFLOW_INPUT_JSON: JSON.stringify({
      dataSourceId: 'ds-123',
      drain: true,
      limit: 25,
      maxBatches: 12,
      maxRuntimeSeconds: 300,
      projectSlug: 'sample-a',
      resumeFrom: 'parse',
      source: 'github',
    }),
  });

  assert.equal(result.exitCode, 0);
  const planned = result.events.find((event) => event.event === 'job_planned') as
    | { argv?: string[]; input?: Record<string, unknown> }
    | undefined;
  assert.ok(planned);
  assert.equal(planned?.input?.dataSourceId, 'ds-123');
  assert.equal(planned?.input?.drain, true);
  assert.equal(planned?.input?.dryRun, true);
  assert.equal(planned?.input?.fixture, false);
  assert.equal(planned?.input?.limit, 25);
  assert.equal(planned?.input?.maxBatches, 12);
  assert.equal(planned?.input?.maxRuntimeSeconds, 300);
  assert.equal(planned?.input?.projectSlug, 'sample-a');
  assert.equal(planned?.input?.resumeFrom, 'parse');
  assert.equal(planned?.input?.source, 'github');
  assert.ok(planned?.argv?.includes('--drain'));
  assert.ok(planned?.argv?.includes('--max-batches'));
  assert.ok(planned?.argv?.includes('12'));
  assert.ok(planned?.argv?.includes('--max-runtime-seconds'));
  assert.ok(planned?.argv?.includes('300'));
  assert.ok(planned?.argv?.includes('--data-source-id'));
  assert.ok(planned?.argv?.includes('ds-123'));
});

test('rejects invalid drain boolean in WORKFLOW_INPUT_JSON', async () => {
  const result = await runWorkflowJob({
    DRY_RUN: 'true',
    WORKFLOW_ID: 'ingest-workflow',
    WORKFLOW_INPUT_JSON: JSON.stringify({
      drain: 'yes',
      projectSlug: 'sample-a',
      source: 'github',
    }),
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /drain must be a boolean/);
});

test('source-sync-dispatcher job plan does not require a project input', async () => {
  const result = await runWorkflowJob({
    DRY_RUN: 'true',
    WORKFLOW_ID: 'source-sync-dispatcher',
    WORKFLOW_INPUT_JSON: '{}',
  });
  assert.equal(result.exitCode, 0);
  const planned = result.events.find((event) => event.event === 'job_planned') as
    | { argv?: string[] }
    | undefined;
  assert.ok(planned?.argv?.some((value) => value.endsWith('source-sync-dispatcher.ts')));
  assert.ok(planned?.argv?.includes('--once'));
});
