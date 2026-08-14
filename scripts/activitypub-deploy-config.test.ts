import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

const productionAppHostingPath = new URL('../apps/web/apphosting.yaml', import.meta.url);
const exampleAppHostingPath = new URL(
  '../deploy/examples/gcp-cloud-build/apphosting.example.yaml',
  import.meta.url,
);
const productionAppHosting = await readFile(productionAppHostingPath, 'utf8');
const exampleAppHosting = await readFile(exampleAppHostingPath, 'utf8');

type AppHostingEnvEntry = {
  readonly variable: string;
  readonly value?: string;
  readonly secret?: string;
  readonly availability?: readonly string[];
};

type AppHostingConfig = {
  readonly env?: readonly AppHostingEnvEntry[];
};

function parseAppHostingConfig(contents: string): AppHostingConfig {
  const parsed: unknown = parseYaml(contents);
  assert.ok(
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
    'App Hosting config root must be an object',
  );
  const root = parsed as Record<string, unknown>;
  if (root.env !== undefined) {
    assert.ok(Array.isArray(root.env), 'env must be an array');
    for (const entry of root.env) {
      assert.ok(
        entry !== null && typeof entry === 'object' && !Array.isArray(entry),
        'env entry must be an object',
      );
      const record = entry as Record<string, unknown>;
      assert.equal(typeof record.variable, 'string', 'env entry variable must be a string');
      if (record.value !== undefined) {
        assert.equal(typeof record.value, 'string', 'env entry value must be a string');
      }
      if (record.secret !== undefined) {
        assert.equal(typeof record.secret, 'string', 'env entry secret must be a string');
      }
      if (record.availability !== undefined) {
        assert.ok(Array.isArray(record.availability), 'availability must be an array');
        for (const item of record.availability) {
          assert.equal(typeof item, 'string', 'availability entry must be a string');
        }
      }
    }
  }
  return parsed as AppHostingConfig;
}

function findAppHostingEnvEntry(
  config: AppHostingConfig,
  variable: string,
): AppHostingEnvEntry | undefined {
  return config.env?.find((entry) => entry.variable === variable);
}

function assertRuntimeAvailability(entry: AppHostingEnvEntry, variable: string): void {
  assert.deepEqual(
    entry.availability,
    ['RUNTIME'],
    `${variable} availability must be exactly RUNTIME`,
  );
}

function assertAppHostingActivityPubConfig(
  contents: string,
  canonicalOrigin: string,
  dispatcherJobName: string,
): void {
  const config = parseAppHostingConfig(contents);

  const enabled = findAppHostingEnvEntry(config, 'ACTIVITYPUB_ENABLED');
  assert.ok(enabled, 'ACTIVITYPUB_ENABLED env entry is required');
  assert.equal(enabled.value, '1');
  assertRuntimeAvailability(enabled, 'ACTIVITYPUB_ENABLED');

  const triggerEnabled = findAppHostingEnvEntry(
    config,
    'ACTIVITYPUB_INBOX_DISPATCHER_TRIGGER_ENABLED',
  );
  assert.ok(triggerEnabled, 'ACTIVITYPUB_INBOX_DISPATCHER_TRIGGER_ENABLED env entry is required');
  assert.equal(triggerEnabled.value, '1');
  assertRuntimeAvailability(triggerEnabled, 'ACTIVITYPUB_INBOX_DISPATCHER_TRIGGER_ENABLED');

  const dispatcherJob = findAppHostingEnvEntry(config, 'PUFU_LENS_ACTIVITYPUB_DISPATCHER_JOB_NAME');
  assert.ok(dispatcherJob, 'PUFU_LENS_ACTIVITYPUB_DISPATCHER_JOB_NAME env entry is required');
  assert.equal(dispatcherJob.value, dispatcherJobName);
  assertRuntimeAvailability(dispatcherJob, 'PUFU_LENS_ACTIVITYPUB_DISPATCHER_JOB_NAME');

  const projectId = findAppHostingEnvEntry(config, 'PUFU_LENS_GCP_PROJECT_ID');
  assert.ok(projectId, 'PUFU_LENS_GCP_PROJECT_ID env entry is required');
  assertRuntimeAvailability(projectId, 'PUFU_LENS_GCP_PROJECT_ID');

  const jobsRegion = findAppHostingEnvEntry(config, 'PUFU_LENS_CLOUD_RUN_JOBS_REGION');
  assert.ok(jobsRegion, 'PUFU_LENS_CLOUD_RUN_JOBS_REGION env entry is required');
  assertRuntimeAvailability(jobsRegion, 'PUFU_LENS_CLOUD_RUN_JOBS_REGION');

  const origin = findAppHostingEnvEntry(config, 'ACTIVITYPUB_CANONICAL_ORIGIN');
  assert.ok(origin, 'ACTIVITYPUB_CANONICAL_ORIGIN env entry is required');
  assert.equal(origin.value, canonicalOrigin);
  assertRuntimeAvailability(origin, 'ACTIVITYPUB_CANONICAL_ORIGIN');

  const dbMaxConnections = findAppHostingEnvEntry(config, 'ACTIVITYPUB_DB_MAX_CONNECTIONS');
  assert.ok(dbMaxConnections, 'ACTIVITYPUB_DB_MAX_CONNECTIONS env entry is required');
  assert.equal(dbMaxConnections.value, '5');
  assertRuntimeAvailability(dbMaxConnections, 'ACTIVITYPUB_DB_MAX_CONNECTIONS');

  const encryptionKey = findAppHostingEnvEntry(config, 'ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY');
  assert.ok(encryptionKey, 'ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY env entry is required');
  assert.equal(encryptionKey.secret, 'ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY');
  assert.equal(encryptionKey.value, undefined);
  assertRuntimeAvailability(encryptionKey, 'ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY');
}

test('production App Hosting configures ActivityPub runtime env and encryption secret', () => {
  assertAppHostingActivityPubConfig(
    productionAppHosting,
    'https://pufu-lens-web--pufu-lens.asia-east1.hosted.app',
    'production-activitypub-dispatcher',
  );
});

test('OSS App Hosting example documents ActivityPub runtime env placeholders', () => {
  assertAppHostingActivityPubConfig(
    exampleAppHosting,
    '<web-public-origin>',
    '<env>-activitypub-dispatcher',
  );
});

test('deploy config validates ActivityPub substitutions and passes canonical origin to smoke', () => {
  const validate = collectSteps().find((step) => step.id === 'validate-deploy-substitutions');
  const smoke = collectSteps().find((step) => step.id === 'smoke');
  assert.ok(validate);
  assert.ok(smoke);

  assert.match(validate.script, /validate_https_origin/);
  assert.match(validate.script, /_ACTIVITYPUB_CANONICAL_ORIGIN/);
  assert.match(validate.script, /_ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE/);
  assert.match(
    validate.script,
    /\[\[ "\$\{_ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT\}" =~ \^\[0-9\]\+\$ \]\]/,
  );
  assert.match(
    validate.script,
    /gcloud iam service-accounts describe "\$\{_SCHEDULER_SERVICE_ACCOUNT\}"/,
  );
  assert.match(validate.script, /uniqueId/);
  assert.match(validate.script, /gcloud secrets describe "\$\{_ACTIVITYPUB_ACTOR_KEY_SECRET\}"/);
  assert.match(
    validate.script,
    /gcloud secrets versions list "\$\{_ACTIVITYPUB_ACTOR_KEY_SECRET\}" --filter='state:ENABLED'/,
  );
  assert.doesNotMatch(validate.script, /gcloud secrets versions access/);

  assert.match(smoke.script, /ACTIVITYPUB_CANONICAL_ORIGIN="\$\{_ACTIVITYPUB_CANONICAL_ORIGIN\}"/);
  assert.match(
    deployYaml,
    /- id: smoke\n\s+name: \$\{_REGION\}-docker\.pkg\.dev\/\$\{PROJECT_ID\}\/\$\{_ARTIFACT_REPO\}\/\$\{_JOBS_IMAGE\}:\$\{SHORT_SHA\}/,
  );
  assert.match(smoke.script, /node --experimental-strip-types \/app\/scripts\/deploy-smoke\.ts/);
});

test('parseAppHostingConfig rejects invalid env shape with explicit assertion message', () => {
  assert.throws(
    () => parseAppHostingConfig('env: true\n'),
    (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.equal(error.message, 'env must be an array');
      return true;
    },
  );
});

function extractValidateHttpsOriginPython(script: string): string {
  const match = script.match(/python3 - <<'PY'\n([\s\S]*?)\n\s*PY/);
  assert.ok(match?.[1], 'validate_https_origin Python heredoc not found');
  return match[1];
}

function runValidateHttpsOriginScript(input: { canonicalOrigin: string; oidcAudience: string }): {
  exitCode: number;
  stderr: string;
} {
  const validate = collectSteps().find((step) => step.id === 'validate-deploy-substitutions');
  assert.ok(validate);
  const pythonScript = extractValidateHttpsOriginPython(validate.script);
  try {
    execFileSync('python3', ['-c', pythonScript], {
      env: {
        ...process.env,
        _ACTIVITYPUB_CANONICAL_ORIGIN: input.canonicalOrigin,
        _ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE: input.oidcAudience,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return { exitCode: 0, stderr: '' };
  } catch (error: unknown) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number'
    ) {
      const execError = error as { status: number; stderr?: string | Buffer };
      const stderr =
        typeof execError.stderr === 'string'
          ? execError.stderr
          : (execError.stderr?.toString('utf8') ?? '');
      return { exitCode: execError.status, stderr };
    }
    throw error;
  }
}

test('deploy config validate_https_origin rejects malformed ports and accepts valid HTTPS origins', () => {
  const valid = runValidateHttpsOriginScript({
    canonicalOrigin: 'https://example.test',
    oidcAudience: 'https://example.test',
  });
  assert.equal(valid.exitCode, 0, valid.stderr);

  const nonNumericPort = runValidateHttpsOriginScript({
    canonicalOrigin: 'https://example.test:not-a-port',
    oidcAudience: 'https://example.test',
  });
  assert.notEqual(nonNumericPort.exitCode, 0);
  assert.match(nonNumericPort.stderr, /must be a valid HTTPS origin/);

  const outOfRangePort = runValidateHttpsOriginScript({
    canonicalOrigin: 'https://example.test',
    oidcAudience: 'https://example.test:65536',
  });
  assert.notEqual(outOfRangePort.exitCode, 0);
  assert.match(outOfRangePort.stderr, /must be a valid HTTPS origin/);
});
