import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

const deployPath = new URL(
  '../deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml',
  import.meta.url,
);
const deployYaml = await readFile(deployPath, 'utf8');
const deploy = parseYaml(deployYaml) as {
  substitutions?: Record<string, string>;
  steps?: Array<{
    id?: string;
    waitFor?: string[];
    args?: string[];
  }>;
};

type DeployStep = {
  readonly id: string;
  readonly waitFor: readonly string[];
  readonly script: string;
};

function collectSteps(): DeployStep[] {
  const steps = deploy.steps ?? [];
  return steps
    .filter((step): step is { id: string; waitFor?: string[]; args?: string[] } => Boolean(step.id))
    .map((step) => ({
      id: step.id,
      waitFor: step.waitFor ?? [],
      script: (step.args ?? []).join('\n'),
    }));
}

test('deploy config step waitFor references only defined step IDs', () => {
  const steps = collectSteps();
  const stepIds = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dependency of step.waitFor) {
      assert.ok(
        stepIds.has(dependency),
        `${step.id} waitFor references unknown step ${dependency}`,
      );
    }
  }
});

test('deploy config creates ActivityPub dispatcher job and five-minute scheduler', () => {
  const steps = collectSteps();
  const scheduler = steps.find((step) => step.id === 'deploy-activitypub-dispatcher-scheduler');
  assert.ok(scheduler);
  assert.match(deployYaml, /activitypub-dispatcher/);
  assert.match(
    deployYaml,
    /for workflow_id in curate-workflow ingest-workflow generate-report source-sync-dispatcher report-schedule-dispatcher activitypub-dispatcher/,
  );
  assert.match(scheduler.script, /internal\/schedules\/activitypub-dispatcher:run/);
  assert.match(deployYaml, /ACTIVITYPUB_CANONICAL_ORIGIN/);
  assert.match(deployYaml, /ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY/);
  assert.match(deployYaml, /SCHEDULER_SERVICE_ACCOUNT/);
});

test('deploy config rejects placeholder ActivityPub defaults and uses resource-scoped IAM', () => {
  assert.doesNotMatch(deployYaml, /https:\/\/lens\.example/);
  assert.doesNotMatch(deployYaml, /https:\/\/mastra\.example/);
  assert.doesNotMatch(deployYaml, /scheduler@example\.iam\.gserviceaccount\.com/);
  assert.match(deployYaml, /add-iam-policy-binding/);
  assert.match(deployYaml, /roles\/run\.invoker/);
  assert.match(deployYaml, /roles\/run\.jobsExecutorWithOverrides/);
  assert.match(deployYaml, /roles\/run\.viewer/);
  assert.doesNotMatch(
    deployYaml,
    /gcloud run (services|jobs) add-iam-policy-binding[^\n]*--project/,
  );
});

test('deploy config sets ActivityPub dispatcher OIDC audience on first Mastra revision', () => {
  const substitutions = deploy.substitutions ?? {};
  assert.equal('_ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE' in substitutions, true);
  assert.match(deployYaml, /_ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE/);
  assert.match(
    deployYaml,
    /ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE=\$\{_ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE\}/,
  );
  assert.doesNotMatch(
    deployYaml,
    /gcloud run services update[\s\S]*ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE/,
  );
});

type JobIamBinding = {
  readonly jobRef: string;
  readonly role: string;
};

function extractJobNameAssignments(script: string): Record<string, string> {
  const assignments: Record<string, string> = {};
  const pattern = /^([a-z_]+)="\$\{_ENV\}-\$\{(_[A-Z0-9_]+)\}"/gm;
  for (const match of script.matchAll(pattern)) {
    const variable = match[1];
    const substitution = match[2];
    if (!variable || !substitution) {
      continue;
    }
    assignments[variable] = `\${_ENV}-\${${substitution}}`;
  }
  return assignments;
}

function extractJobIamBindings(script: string): JobIamBinding[] {
  const bindings: JobIamBinding[] = [];
  const commandPattern =
    /gcloud run jobs add-iam-policy-binding "([^"]+)"[\s\S]*?--role "([^"]+)"/g;
  for (const match of script.matchAll(commandPattern)) {
    const jobRef = match[1];
    const role = match[2];
    if (!jobRef || !role) {
      continue;
    }
    bindings.push({ jobRef, role });
  }
  return bindings;
}

function extractWorkflowJobNameAssignment(script: string, workflowId: string): string | undefined {
  const marker = `${workflowId})`;
  const index = script.indexOf(marker);
  if (index < 0) {
    return undefined;
  }
  const slice = script.slice(index, index + 200);
  const match = slice.match(/job_name="([^"]+)"/);
  return match?.[1];
}

function extractDefaultWorkflowJobNameAssignment(script: string): string | undefined {
  const marker = '*)';
  const index = script.indexOf(marker);
  if (index < 0) {
    return undefined;
  }
  const slice = script.slice(index, index + 200);
  const match = slice.match(/job_name="([^"]+)"/);
  return match?.[1];
}

test('deploy-workflow-jobs uses substitution-derived dispatcher job names aligned with IAM bindings', () => {
  const steps = collectSteps();
  const workflowJobs = steps.find((step) => step.id === 'deploy-workflow-jobs');
  const iam = steps.find((step) => step.id === 'deploy-activitypub-dispatcher-iam');
  assert.ok(workflowJobs);
  assert.ok(iam);

  const dispatcherJobPatterns = {
    'source-sync-dispatcher': `\${_ENV}-\${_SOURCE_SYNC_DISPATCHER_JOB}`,
    'report-schedule-dispatcher': `\${_ENV}-\${_REPORT_SCHEDULE_DISPATCHER_JOB}`,
    'activitypub-dispatcher': `\${_ENV}-\${_ACTIVITYPUB_DISPATCHER_JOB}`,
  } as const;

  for (const [workflowId, expectedJobName] of Object.entries(dispatcherJobPatterns)) {
    assert.equal(
      extractWorkflowJobNameAssignment(workflowJobs.script, workflowId),
      expectedJobName,
    );
  }
  assert.equal(
    extractDefaultWorkflowJobNameAssignment(workflowJobs.script),
    `\${_ENV}-$\${workflow_id}`,
  );

  assert.ok(workflowJobs.script.includes('gcloud run jobs describe "$${job_name}"'));
  assert.ok(workflowJobs.script.includes('gcloud run jobs update "$${job_args[@]}"'));
  assert.ok(workflowJobs.script.includes('gcloud run jobs create "$${job_args[@]}"'));
  assert.ok(workflowJobs.script.includes('"$${job_name}"'));

  const iamJobNames = extractJobNameAssignments(iam.script);
  assert.equal(iamJobNames.source_sync_job_name, dispatcherJobPatterns['source-sync-dispatcher']);
  assert.equal(
    iamJobNames.report_schedule_job_name,
    dispatcherJobPatterns['report-schedule-dispatcher'],
  );
  assert.equal(iamJobNames.activitypub_job_name, dispatcherJobPatterns['activitypub-dispatcher']);
});

test('deploy config scopes dispatcher IAM to environment-prefixed jobs and orders IAM before scheduler', () => {
  const steps = collectSteps();
  const iam = steps.find((step) => step.id === 'deploy-activitypub-dispatcher-iam');
  const scheduler = steps.find((step) => step.id === 'deploy-activitypub-dispatcher-scheduler');
  assert.ok(iam);
  assert.ok(scheduler);

  const jobNames = extractJobNameAssignments(iam.script);
  assert.deepEqual(jobNames, {
    source_sync_job_name: `\${_ENV}-\${_SOURCE_SYNC_DISPATCHER_JOB}`,
    report_schedule_job_name: `\${_ENV}-\${_REPORT_SCHEDULE_DISPATCHER_JOB}`,
    activitypub_job_name: `\${_ENV}-\${_ACTIVITYPUB_DISPATCHER_JOB}`,
  });
  assert.match(
    iam.script,
    /for dispatcher_job_name in "\$\$\{source_sync_job_name\}" "\$\$\{report_schedule_job_name\}" "\$\$\{activitypub_job_name\}"; do[\s\S]*roles\/run\.jobsExecutorWithOverrides/,
  );

  const bindings = extractJobIamBindings(iam.script);
  const executorJobs = bindings
    .filter((binding) => binding.role === 'roles/run.jobsExecutorWithOverrides')
    .map((binding) => binding.jobRef);
  const viewerJobs = bindings
    .filter((binding) => binding.role === 'roles/run.viewer')
    .map((binding) => binding.jobRef);

  assert.deepEqual(executorJobs, ['$${dispatcher_job_name}']);
  assert.deepEqual(viewerJobs, ['$${activitypub_job_name}']);

  assert.match(iam.script, /gcloud run services add-iam-policy-binding[\s\S]*roles\/run\.invoker/);

  const iamIndex = steps.findIndex((step) => step.id === 'deploy-activitypub-dispatcher-iam');
  const schedulerIndex = steps.findIndex(
    (step) => step.id === 'deploy-activitypub-dispatcher-scheduler',
  );
  assert.ok(iamIndex < schedulerIndex);
  assert.deepEqual(scheduler.waitFor, [
    'deploy-mastra-server',
    'deploy-workflow-jobs',
    'deploy-activitypub-dispatcher-iam',
  ]);
});

test('deploy config uses fixed ActivityPub dispatcher scheduler OIDC audience substitution', () => {
  const scheduler = collectSteps().find(
    (step) => step.id === 'deploy-activitypub-dispatcher-scheduler',
  );
  assert.ok(scheduler);
  assert.match(
    scheduler.script,
    /--oidc-token-audience "\$\{_ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE\}"/,
  );
  assert.doesNotMatch(scheduler.script, /--oidc-token-audience "\$\{service_url\}"/);
  assert.match(deployYaml, /mastra-server-url/);
});
