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

test('deploy config scopes ActivityPub dispatcher IAM to the target job and orders IAM before scheduler', () => {
  const steps = collectSteps();
  const iam = steps.find((step) => step.id === 'deploy-activitypub-dispatcher-iam');
  const scheduler = steps.find((step) => step.id === 'deploy-activitypub-dispatcher-scheduler');
  assert.ok(iam);
  assert.ok(scheduler);
  assert.match(iam.script, /activitypub_job_name="\$\{_ENV\}-\$\{_ACTIVITYPUB_DISPATCHER_JOB\}"/);
  assert.match(iam.script, /gcloud run jobs add-iam-policy-binding "\$\$\{activitypub_job_name\}"/);
  assert.match(iam.script, /roles\/run\.jobsExecutorWithOverrides/);
  assert.match(iam.script, /roles\/run\.viewer/);
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
