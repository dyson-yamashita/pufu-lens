import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

const deployPath = new URL(
  '../deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml',
  import.meta.url,
);
const deployYaml = await readFile(deployPath, 'utf8');

type DeployConfig = {
  substitutions?: Record<string, string>;
  steps?: Array<{
    id?: string;
    env?: string[];
    args?: string[];
  }>;
};

const deploy = parseYaml(deployYaml) as DeployConfig;

const DOLLAR_ESCAPE = '__CLOUD_BUILD_DOLLAR_ESCAPE__';
const BUILTIN_SUBSTITUTIONS: Record<string, string> = {
  PROJECT_ID: 'test-project',
  SHORT_SHA: 'abc1234',
  COMMIT_SHA: 'abc1234',
};

const BASE_SUBSTITUTIONS: Record<string, string> = {
  ...(deploy.substitutions ?? {}),
  _RUNTIME_SERVICE_ACCOUNT: 'runtime@test-project.iam.gserviceaccount.com',
  _SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test-project.iam.gserviceaccount.com',
  _STORAGE_BUCKET: 'test-bucket',
  _ACTIVITYPUB_CANONICAL_ORIGIN: 'https://example.test',
  _ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE: 'https://example.test',
  _ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT: '1234567890',
  _ACTIVITYPUB_ACTOR_KEY_SECRET: 'ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY',
  _RUN_DB_MIGRATIONS: 'false',
};

const COLLECTION_JOBS = ['curate-workflow', 'ingest-workflow', 'source-sync-dispatcher'] as const;
const ALL_WORKFLOW_JOBS = [
  'curate-workflow',
  'ingest-workflow',
  'generate-report',
  'source-sync-dispatcher',
  'report-schedule-dispatcher',
  'activitypub-dispatcher',
] as const;

const OAUTH_REF_FIELDS = [
  {
    substitutionKey: '_GOOGLE_CLIENT_ID_SECRET_REF',
    envName: 'GOOGLE_CLIENT_ID_SECRET_REF',
    validValue: 'google-client-id:1',
  },
  {
    substitutionKey: '_GOOGLE_CLIENT_SECRET_REF',
    envName: 'GOOGLE_CLIENT_SECRET_REF',
    validValue: 'google-client-secret:1',
  },
  {
    substitutionKey: '_CONNECTION_SECRET_KEY_REF',
    envName: 'CONNECTION_SECRET_KEY_REF',
    validValue: 'connection-secret-key:1',
  },
] as const;

const INVALID_SECRET_REF_VALUES = [
  'has space:1',
  'has,comma:1',
  '$(echo MARKER):1',
  'no-version',
  'name:0',
  'path/slash:1',
  'name\ninjected:1',
] as const;

function getStep(stepId: string) {
  const step = deploy.steps?.find((entry) => entry.id === stepId);
  assert.ok(step, `missing Cloud Build step ${stepId}`);
  return step;
}

function extractStepScript(stepId: string): string {
  const args = getStep(stepId).args ?? [];
  assert.equal(args[0], '-c', `unexpected args shape for Cloud Build step ${stepId}`);
  assert.equal(args.length, 2, `unexpected args shape for Cloud Build step ${stepId}`);
  const script = args[1];
  assert.ok(script, `missing script body for Cloud Build step ${stepId}`);
  return script;
}

function mergeSubstitutions(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_SUBSTITUTIONS, ...overrides };
}

function applyCloudBuildSubstitutions(
  input: string,
  substitutions: Record<string, string>,
): string {
  const protectedInput = input.replaceAll('$$', DOLLAR_ESCAPE);
  const substituted = protectedInput.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    if (name in substitutions) {
      return substitutions[name] ?? match;
    }
    if (name in BUILTIN_SUBSTITUTIONS) {
      return BUILTIN_SUBSTITUTIONS[name] ?? match;
    }
    return match;
  });
  return substituted.replaceAll(DOLLAR_ESCAPE, '$');
}

function resolveStepEnv(
  stepId: string,
  substitutions: Record<string, string>,
): Record<string, string> {
  const envEntries = getStep(stepId).env ?? [];
  const resolved: Record<string, string> = {};
  for (const entry of envEntries) {
    const separator = entry.indexOf('=');
    assert.ok(separator > 0, `invalid env entry for ${stepId}: ${entry}`);
    const key = entry.slice(0, separator);
    const value = applyCloudBuildSubstitutions(entry.slice(separator + 1), substitutions);
    resolved[key] = value;
  }
  return resolved;
}

function validPairSubstitutions(): Record<string, string> {
  return {
    _GOOGLE_CLIENT_ID_SECRET_REF: 'google-client-id:1',
    _GOOGLE_CLIENT_SECRET_REF: 'google-client-secret:1',
  };
}

function assertOutputOmitsValue(output: string, value: string, marker = 'MARKER'): void {
  assert.doesNotMatch(output, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(output, new RegExp(marker));
}

type MockGcloud = {
  binDir: string;
  logPath: string;
  cleanup: () => Promise<void>;
};

async function createMockGcloud(options: {
  describeExitCode?: number;
  schedulerUniqueId?: string;
}): Promise<MockGcloud> {
  const binDir = await mkdtemp(join(tmpdir(), 'fake-gcloud-oauth-'));
  const logPath = join(binDir, 'gcloud.log');
  const describeExitCode = options.describeExitCode ?? 0;
  const schedulerUniqueId = options.schedulerUniqueId ?? '1234567890';
  const nodeExecutable = process.execPath.replace(/'/g, `'\\''`);
  const script = `#!/usr/bin/env bash
set -euo pipefail
log_path='${logPath}'
node_executable='${nodeExecutable}'
"$node_executable" -e 'require("fs").appendFileSync(process.env.FAKE_GCLOUD_LOG_PATH, JSON.stringify(process.argv.slice(1)) + "\\n")' "$@"
if [[ "$1" == "iam" && "$2" == "service-accounts" && "$3" == "describe" ]]; then
  echo "${schedulerUniqueId}"
  exit 0
fi
if [[ "$1" == "secrets" && "$2" == "describe" ]]; then
  exit 0
fi
if [[ "$1" == "secrets" && "$2" == "versions" && "$3" == "list" ]]; then
  echo "projects/test-project/secrets/example/versions/1"
  exit 0
fi
if [[ "$1" == "run" && "$2" == "jobs" && "$3" == "describe" ]]; then
  exit ${describeExitCode}
fi
if [[ "$1" == "run" && "$2" == "jobs" && ( "$3" == "create" || "$3" == "update" ) ]]; then
  exit 0
fi
echo "unexpected gcloud invocation" >&2
exit 1
`;
  await writeFile(join(binDir, 'gcloud'), script, 'utf8');
  await chmod(join(binDir, 'gcloud'), 0o755);
  await writeFile(logPath, '', 'utf8');
  return {
    binDir,
    logPath,
    cleanup: async () => {
      await rm(binDir, { recursive: true, force: true });
    },
  };
}

function runBashScript(
  script: string,
  env: NodeJS.ProcessEnv,
  binDir: string,
): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', ['-c', script], {
      env: {
        ...process.env,
        ...env,
        FAKE_GCLOUD_LOG_PATH: join(binDir, 'gcloud.log'),
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error: unknown) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number'
    ) {
      const execError = error as {
        status: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      return {
        exitCode: execError.status,
        stdout:
          typeof execError.stdout === 'string'
            ? execError.stdout
            : (execError.stdout?.toString('utf8') ?? ''),
        stderr:
          typeof execError.stderr === 'string'
            ? execError.stderr
            : (execError.stderr?.toString('utf8') ?? ''),
      };
    }
    throw error;
  }
}

async function runValidateStep(
  substitutions: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; log: string }> {
  const merged = mergeSubstitutions(substitutions);
  const mock = await createMockGcloud({
    schedulerUniqueId: merged._ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT,
  });
  try {
    const script = applyCloudBuildSubstitutions(
      extractStepScript('validate-deploy-substitutions'),
      merged,
    );
    const stepEnv = resolveStepEnv('validate-deploy-substitutions', merged);
    const result = runBashScript(script, stepEnv, mock.binDir);
    const log = await readFile(mock.logPath, 'utf8');
    return { ...result, log };
  } finally {
    await mock.cleanup();
  }
}

async function runDeployWorkflowJobs(
  substitutions: Record<string, string> = {},
  describeExitCode: number = 1,
): Promise<{ exitCode: number; stderr: string; log: string }> {
  const mock = await createMockGcloud({ describeExitCode });
  try {
    const merged = mergeSubstitutions(substitutions);
    const script = applyCloudBuildSubstitutions(extractStepScript('deploy-workflow-jobs'), merged);
    const stepEnv = resolveStepEnv('deploy-workflow-jobs', merged);
    const result = runBashScript(script, stepEnv, mock.binDir);
    const log = await readFile(mock.logPath, 'utf8');
    return { exitCode: result.exitCode, stderr: result.stderr, log };
  } finally {
    await mock.cleanup();
  }
}

function parseGcloudLog(log: string): string[][] {
  return log
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function findJobInvocation(log: string, jobName: string, action: 'create' | 'update'): string[] {
  const invocation = parseGcloudLog(log).find(
    (argv) => argv[0] === 'run' && argv[1] === 'jobs' && argv[2] === action && argv[3] === jobName,
  );
  assert.ok(invocation, `missing ${action} invocation for ${jobName}`);
  return invocation;
}

function secretsFromInvocation(argv: string[]): string {
  const index = argv.indexOf('--set-secrets');
  assert.ok(index >= 0, `missing --set-secrets in ${argv.join(' ')}`);
  return argv[index + 1] ?? '';
}

test('deploy config declares optional Google OAuth secret reference substitutions from YAML', () => {
  const substitutions = deploy.substitutions ?? {};
  assert.equal(substitutions._GOOGLE_CLIENT_ID_SECRET_REF, '');
  assert.equal(substitutions._GOOGLE_CLIENT_SECRET_REF, '');
  assert.equal(substitutions._CONNECTION_SECRET_KEY_REF, '');
  assert.equal(BASE_SUBSTITUTIONS._GOOGLE_CLIENT_ID_SECRET_REF, '');
  assert.equal(BASE_SUBSTITUTIONS._GOOGLE_CLIENT_SECRET_REF, '');
  assert.equal(BASE_SUBSTITUTIONS._CONNECTION_SECRET_KEY_REF, '');
  assert.match(deployYaml, /GOOGLE_CLIENT_ID_SECRET_REF=\$\{_GOOGLE_CLIENT_ID_SECRET_REF\}/);
  assert.match(deployYaml, /GOOGLE_CLIENT_SECRET_REF=\$\{_GOOGLE_CLIENT_SECRET_REF\}/);
  assert.match(deployYaml, /CONNECTION_SECRET_KEY_REF=\$\{_CONNECTION_SECRET_KEY_REF\}/);
  assert.doesNotMatch(deployYaml, /GOOGLE_CLIENT_SECRET_SECRET_REF/);
});

test('validate step maps Google OAuth references through step env before external calls', async () => {
  const accepted = await runValidateStep({
    _GOOGLE_CLIENT_ID_SECRET_REF: 'google-client-id:1',
    _GOOGLE_CLIENT_SECRET_REF: 'google-client-secret:latest',
    _CONNECTION_SECRET_KEY_REF: 'connection-secret-key:2',
  });
  assert.equal(accepted.exitCode, 0, accepted.stderr);

  const defaults = await runValidateStep();
  assert.equal(defaults.exitCode, 0, defaults.stderr);

  const keyOnly = await runValidateStep({
    _CONNECTION_SECRET_KEY_REF: 'connection-secret-key:latest',
  });
  assert.equal(keyOnly.exitCode, 0, keyOnly.stderr);

  const accepted255 = await runValidateStep({
    _GOOGLE_CLIENT_ID_SECRET_REF: `${'a'.repeat(255)}:latest`,
    _GOOGLE_CLIENT_SECRET_REF: 'google-client-secret:1',
  });
  assert.equal(accepted255.exitCode, 0, accepted255.stderr);

  const rejected256 = await runValidateStep({
    _GOOGLE_CLIENT_ID_SECRET_REF: `${'a'.repeat(256)}:latest`,
    _GOOGLE_CLIENT_SECRET_REF: 'google-client-secret:1',
  });
  assert.notEqual(rejected256.exitCode, 0);
  assert.match(
    rejected256.stderr,
    /GOOGLE_CLIENT_ID_SECRET_REF must be a valid Secret Manager reference\./,
  );
  assertOutputOmitsValue(rejected256.stdout + rejected256.stderr, `${'a'.repeat(256)}:latest`);
});

test('validate step rejects one-sided Google OAuth client reference pairs', async () => {
  const idOnly = await runValidateStep({
    _GOOGLE_CLIENT_ID_SECRET_REF: 'google-client-id:1',
  });
  assert.notEqual(idOnly.exitCode, 0);
  assert.match(
    idOnly.stderr,
    /GOOGLE_CLIENT_ID_SECRET_REF and GOOGLE_CLIENT_SECRET_REF must both be set or both be empty\./,
  );
  assertOutputOmitsValue(idOnly.stdout + idOnly.stderr, 'google-client-id:1');

  const secretOnly = await runValidateStep({
    _GOOGLE_CLIENT_SECRET_REF: 'google-client-secret:1',
  });
  assert.notEqual(secretOnly.exitCode, 0);
  assert.match(
    secretOnly.stderr,
    /GOOGLE_CLIENT_ID_SECRET_REF and GOOGLE_CLIENT_SECRET_REF must both be set or both be empty\./,
  );
  assertOutputOmitsValue(secretOnly.stdout + secretOnly.stderr, 'google-client-secret:1');
  assert.doesNotMatch(secretOnly.log, /"update"/);
});

test('validate step rejects malformed Google OAuth secret references without echoing values', async () => {
  for (const field of OAUTH_REF_FIELDS) {
    for (const invalidValue of INVALID_SECRET_REF_VALUES) {
      const substitutions: Record<string, string> = {
        ...validPairSubstitutions(),
        _CONNECTION_SECRET_KEY_REF: 'connection-secret-key:1',
      };
      substitutions[field.substitutionKey] = invalidValue;
      const result = await runValidateStep(substitutions);
      assert.notEqual(result.exitCode, 0, `${field.envName} ${invalidValue}`);
      assert.match(
        result.stderr,
        new RegExp(`${field.envName} must be a valid Secret Manager reference\\.`),
      );
      assertOutputOmitsValue(result.stdout + result.stderr, invalidValue);
      assert.doesNotMatch(result.log, /"update"/);
    }
  }
});

test('validate step rejects command substitution probes passed through substitution to step env', async () => {
  const result = await runValidateStep({
    _GOOGLE_CLIENT_ID_SECRET_REF: '$(echo INJECTED >&2):1',
    _GOOGLE_CLIENT_SECRET_REF: 'google-client-secret:1',
  });
  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /INJECTED/);
  assert.doesNotMatch(result.stderr, /INJECTED/);
  assertOutputOmitsValue(result.stdout + result.stderr, '$(echo INJECTED >&2):1');
});

test('deploy-workflow-jobs appends Google OAuth secrets only to collection jobs', async () => {
  const substitutions = {
    _GOOGLE_CLIENT_ID_SECRET_REF: 'google-client-id:3',
    _GOOGLE_CLIENT_SECRET_REF: 'google-client-secret:latest',
    _CONNECTION_SECRET_KEY_REF: 'connection-secret-key:4',
  };

  for (const describeExitCode of [0, 1] as const) {
    const result = await runDeployWorkflowJobs(substitutions, describeExitCode);
    assert.equal(result.exitCode, 0, result.stderr);

    for (const workflowId of ALL_WORKFLOW_JOBS) {
      const jobName = `staging-${workflowId}`;
      const action = describeExitCode === 0 ? 'update' : 'create';
      const argv = findJobInvocation(result.log, jobName, action);
      if (describeExitCode === 0) {
        assert.ok(argv.includes('--clear-vpc-connector'));
      } else {
        assert.ok(!argv.includes('--clear-vpc-connector'));
      }

      const secrets = secretsFromInvocation(argv);
      assert.match(secrets, /DATABASE_URL=DATABASE_URL:latest/);
      assert.match(secrets, /AUTH_SECRET=AUTH_SECRET:latest/);
      assert.match(argv.join(' '), /PUFU_LENS_GRAPH_TRANSITION_MODE=off/);

      if (COLLECTION_JOBS.includes(workflowId as (typeof COLLECTION_JOBS)[number])) {
        assert.match(secrets, /GOOGLE_CLIENT_ID=google-client-id:3/);
        assert.match(secrets, /GOOGLE_CLIENT_SECRET=google-client-secret:latest/);
        assert.match(secrets, /CONNECTION_SECRET_KEY=connection-secret-key:4/);
      } else {
        assert.doesNotMatch(secrets, /GOOGLE_CLIENT_ID=/);
        assert.doesNotMatch(secrets, /GOOGLE_CLIENT_SECRET=/);
        assert.doesNotMatch(secrets, /CONNECTION_SECRET_KEY=/);
      }
    }

    for (const argv of parseGcloudLog(result.log)) {
      assert.ok(
        !(argv[0] === 'secrets' && argv[1] === 'versions' && argv[2] === 'access'),
        'unexpected secret payload access',
      );
    }
  }
});

test('deploy-workflow-jobs with OAuth pair only keeps AUTH_SECRET and omits CONNECTION_SECRET_KEY', async () => {
  const result = await runDeployWorkflowJobs({
    _GOOGLE_CLIENT_ID_SECRET_REF: 'google-client-id:1',
    _GOOGLE_CLIENT_SECRET_REF: 'google-client-secret:latest',
  });
  assert.equal(result.exitCode, 0, result.stderr);

  for (const workflowId of COLLECTION_JOBS) {
    const argv = findJobInvocation(result.log, `staging-${workflowId}`, 'create');
    const secrets = secretsFromInvocation(argv);
    assert.match(secrets, /GOOGLE_CLIENT_ID=google-client-id:1/);
    assert.match(secrets, /GOOGLE_CLIENT_SECRET=google-client-secret:latest/);
    assert.match(secrets, /AUTH_SECRET=AUTH_SECRET:latest/);
    assert.doesNotMatch(secrets, /CONNECTION_SECRET_KEY=/);
    assert.match(secrets, /GEMINI_API_KEY=GEMINI_API_KEY:latest/);
    assert.match(secrets, /PUFU_LENS_EMBEDDING_API_KEY=GEMINI_API_KEY:latest/);
  }

  const activityPubArgv = findJobInvocation(result.log, 'staging-activitypub-dispatcher', 'create');
  const activityPubSecrets = secretsFromInvocation(activityPubArgv);
  assert.match(
    activityPubSecrets,
    /ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY=ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY:latest/,
  );
  assert.doesNotMatch(activityPubSecrets, /GOOGLE_CLIENT_ID=/);
});

test('deploy-workflow-jobs keeps AUTH_SECRET fallback when OAuth pair is omitted', async () => {
  const result = await runDeployWorkflowJobs({
    _CONNECTION_SECRET_KEY_REF: 'connection-secret-key:latest',
  });
  assert.equal(result.exitCode, 0, result.stderr);

  for (const workflowId of COLLECTION_JOBS) {
    const argv = findJobInvocation(result.log, `staging-${workflowId}`, 'create');
    const secrets = secretsFromInvocation(argv);
    assert.match(secrets, /AUTH_SECRET=AUTH_SECRET:latest/);
    assert.doesNotMatch(secrets, /GOOGLE_CLIENT_ID=/);
    assert.doesNotMatch(secrets, /GOOGLE_CLIENT_SECRET=/);
    assert.match(secrets, /CONNECTION_SECRET_KEY=connection-secret-key:latest/);
  }
});

test('deploy-workflow-jobs omits Google OAuth secrets when YAML defaults are empty', async () => {
  const result = await runDeployWorkflowJobs();
  assert.equal(result.exitCode, 0, result.stderr);

  for (const workflowId of ALL_WORKFLOW_JOBS) {
    const argv = findJobInvocation(result.log, `staging-${workflowId}`, 'create');
    const secrets = secretsFromInvocation(argv);
    assert.doesNotMatch(secrets, /GOOGLE_CLIENT_ID=/);
    assert.doesNotMatch(secrets, /GOOGLE_CLIENT_SECRET=/);
    assert.doesNotMatch(secrets, /CONNECTION_SECRET_KEY=/);
  }
});
