import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const deployPath = new URL(
  '../deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml',
  import.meta.url,
);
const productionAppHostingPath = new URL('../apps/web/apphosting.yaml', import.meta.url);
const exampleAppHostingPath = new URL(
  '../deploy/examples/gcp-cloud-build/apphosting.example.yaml',
  import.meta.url,
);

const deployYaml = await readFile(deployPath, 'utf8');
const productionAppHosting = await readFile(productionAppHostingPath, 'utf8');
const exampleAppHosting = await readFile(exampleAppHostingPath, 'utf8');

const deploy = parseYaml(deployYaml) as {
  substitutions?: Record<string, string>;
  steps: Array<{ id: string; waitFor?: string[]; args?: string[]; env?: string[] }>;
};

test('all Cloud Build steps depend on production graph validation before mutation', () => {
  assert.equal(deploy.steps[0]?.id, 'validate-production-graph-mode');
  const guarded = new Set(['validate-production-graph-mode']);
  for (const step of deploy.steps.slice(1)) {
    const dependencies = step.waitFor ?? [...guarded];
    assert.ok(
      dependencies.some((id) => guarded.has(id)),
      `${step.id} bypasses validation`,
    );
    guarded.add(step.id);
  }
  const guard = deploy.steps[0];
  assert.ok(guard?.args?.[1]?.includes('node scripts/validate-production-graph-mode.cjs'));
  assert.deepEqual(guard?.env, [
    `DEPLOY_ENV=\${_ENV}`,
    `GRAPH_TRANSITION_MODE=\${_GRAPH_TRANSITION_MODE}`,
  ]);
});

test('production graph guard accepts matching modes and fails closed on invalid Web configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-mode-'));
  const path = join(root, 'apps/web/apphosting.yaml');
  const script = fileURLToPath(new URL('./validate-production-graph-mode.cjs', import.meta.url));
  await mkdir(join(root, 'apps/web'), { recursive: true });
  const fixture = (mode: string) =>
    `env:\n  - variable: PUFU_LENS_GRAPH_TRANSITION_MODE\n    value: '${mode}'\n    availability: [RUNTIME]\n`;
  try {
    const cases = [
      ...CANONICAL_GRAPH_TRANSITION_MODES.map((mode) => ({ yaml: fixture(mode), mode, ok: true })),
      { yaml: fixture('relational-primary'), mode: 'dual-write-shadow-read', ok: false },
      { yaml: fixture('off'), mode: 'unknown', ok: false },
      { yaml: 'env: []', mode: 'off', ok: false },
      { yaml: fixture('off').replace('[RUNTIME]', '[BUILD]'), mode: 'off', ok: false },
      { yaml: `${fixture('off')}    secret: graph-mode\n`, mode: 'off', ok: false },
      { yaml: fixture('off') + fixture('off').replace('env:\n', ''), mode: 'off', ok: false },
      { yaml: `${fixture('off')}    value: off\n`, mode: 'off', ok: false },
      { yaml: 'env: [', mode: 'off', ok: false },
    ];
    for (const entry of cases) {
      await writeFile(path, entry.yaml);
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, DEPLOY_ENV: 'production', GRAPH_TRANSITION_MODE: entry.mode },
        encoding: 'utf8',
      });
      assert.equal(result.status, entry.ok ? 0 : 1, `${entry.yaml}: ${result.stderr}`);
    }
    await rm(path);
    for (const environment of ['production', 'staging']) {
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, DEPLOY_ENV: environment, GRAPH_TRANSITION_MODE: 'off' },
        encoding: 'utf8',
      });
      assert.equal(result.status, environment === 'production' ? 1 : 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const CANONICAL_GRAPH_TRANSITION_MODES = [
  'off',
  'dual-write',
  'dual-write-shadow-read',
  'relational-primary',
] as const;

function extractStepScript(deployYamlContent: string, stepId: string): string {
  const stepStart = deployYamlContent.indexOf(`- id: ${stepId}`);
  assert.notEqual(stepStart, -1, `missing Cloud Build step ${stepId}`);
  const nextStepStart = deployYamlContent.indexOf('\n  - id: ', stepStart + 1);
  const stepBlock =
    nextStepStart === -1
      ? deployYamlContent.slice(stepStart)
      : deployYamlContent.slice(stepStart, nextStepStart);
  const scriptMatch = stepBlock.match(/args:\s*\n\s*- -c\s*\n\s*- \|\s*\n([\s\S]*)/);
  assert.ok(scriptMatch?.[1], `missing script body for Cloud Build step ${stepId}`);
  return scriptMatch[1];
}

type AppHostingEnvEntry = {
  readonly variable: string;
  readonly value?: string;
  readonly availability?: readonly string[];
};

type AppHostingConfig = {
  readonly env?: readonly AppHostingEnvEntry[];
};

function parseAppHostingConfig(contents: string): AppHostingConfig {
  return parseYaml(contents) as AppHostingConfig;
}

function findAppHostingEnvEntry(
  config: AppHostingConfig,
  variable: string,
): AppHostingEnvEntry | undefined {
  return config.env?.find((entry) => entry.variable === variable);
}

test('Cloud Build declares _GRAPH_TRANSITION_MODE with safe default off', () => {
  const substitutions = deploy.substitutions ?? {};
  assert.equal(substitutions._GRAPH_TRANSITION_MODE, 'off');
});

test('validate-deploy-substitutions accepts canonical graph transition modes and fails closed', () => {
  const validateScript = extractStepScript(deployYaml, 'validate-deploy-substitutions');

  assert.match(validateScript, /case "\$\{_GRAPH_TRANSITION_MODE\}"/);
  assert.match(validateScript, /off\|dual-write\|dual-write-shadow-read\|relational-primary\) ;;/);
  assert.match(
    validateScript,
    /echo "_GRAPH_TRANSITION_MODE must be off, dual-write, dual-write-shadow-read, or relational-primary\." >&2/,
  );
  assert.match(validateScript, /\*\)\s*\n\s*echo "_GRAPH_TRANSITION_MODE/);

  for (const mode of CANONICAL_GRAPH_TRANSITION_MODES) {
    assert.ok(
      validateScript.includes(mode),
      `validate-deploy-substitutions must allow graph transition mode ${mode}`,
    );
  }
});

test('graph mode validation shell accepts all supported modes and rejects unknown values', () => {
  const block = extractStepScript(deployYaml, 'validate-deploy-substitutions').match(
    /case "\$\{_GRAPH_TRANSITION_MODE\}" in[\s\S]*?esac/,
  )?.[0];
  assert.ok(block);
  for (const value of [...CANONICAL_GRAPH_TRANSITION_MODES, '', 'relational-only', 'unknown']) {
    const result: SpawnSyncReturns<string> = spawnSync('bash', ['-c', block], {
      env: { ...process.env, _GRAPH_TRANSITION_MODE: value },
      encoding: 'utf8',
    });
    const accepted = CANONICAL_GRAPH_TRANSITION_MODES.some((mode) => mode === value);
    assert.equal(result.status, accepted ? 0 : 1, `${value}: ${result.stderr}`);
  }
});

test('deploy-mastra-server passes PUFU_LENS_GRAPH_TRANSITION_MODE from substitution', () => {
  const mastraScript = extractStepScript(deployYaml, 'deploy-mastra-server');
  assert.match(mastraScript, /PUFU_LENS_GRAPH_TRANSITION_MODE=\$\{_GRAPH_TRANSITION_MODE\}/);
});

test('deploy-workflow-jobs passes PUFU_LENS_GRAPH_TRANSITION_MODE to every env string', () => {
  const workflowScript = extractStepScript(deployYaml, 'deploy-workflow-jobs');

  const generalEnvMatch = workflowScript.match(/^(\s*)env_vars="STORAGE_DRIVER=gcs[\s\S]*?"\s*$/m);
  assert.ok(generalEnvMatch?.[0], 'expected general workflow env_vars assignment');
  assert.match(generalEnvMatch[0], /PUFU_LENS_GRAPH_TRANSITION_MODE=\$\{_GRAPH_TRANSITION_MODE\}/);

  const activityPubEnvMatch = workflowScript.match(
    /if \[\[ "\$\$\{workflow_id\}" == "activitypub-dispatcher" \]\]; then[\s\S]*?env_vars="([^"]+)"/,
  );
  assert.ok(activityPubEnvMatch?.[1], 'expected ActivityPub dispatcher env_vars assignment');
  assert.match(
    activityPubEnvMatch[1],
    /PUFU_LENS_GRAPH_TRANSITION_MODE=\$\{_GRAPH_TRANSITION_MODE\}/,
  );

  const modeReferences = workflowScript.match(
    /PUFU_LENS_GRAPH_TRANSITION_MODE=\$\{_GRAPH_TRANSITION_MODE\}/g,
  );
  assert.equal(
    modeReferences?.length ?? 0,
    2,
    'workflow jobs must pass graph transition mode in both general and ActivityPub env strings',
  );
});

test('production App Hosting prepares runtime-only PUFU_LENS_GRAPH_TRANSITION_MODE relational-primary', () => {
  const config = parseAppHostingConfig(productionAppHosting);
  const entry = findAppHostingEnvEntry(config, 'PUFU_LENS_GRAPH_TRANSITION_MODE');
  assert.ok(entry, 'PUFU_LENS_GRAPH_TRANSITION_MODE env entry is required');
  assert.equal(entry.value, 'relational-primary');
  assert.deepEqual(entry.availability, ['RUNTIME']);
});

test('OSS App Hosting example declares runtime-only PUFU_LENS_GRAPH_TRANSITION_MODE off', () => {
  const config = parseAppHostingConfig(exampleAppHosting);
  const entry = findAppHostingEnvEntry(config, 'PUFU_LENS_GRAPH_TRANSITION_MODE');
  assert.ok(entry, 'PUFU_LENS_GRAPH_TRANSITION_MODE env entry is required');
  assert.equal(entry.value, 'off');
  assert.deepEqual(entry.availability, ['RUNTIME']);
});

test('deploy config does not introduce NEXT_PUBLIC_PUFU_LENS_GRAPH_TRANSITION_MODE', () => {
  assert.doesNotMatch(deployYaml, /NEXT_PUBLIC_PUFU_LENS_GRAPH_TRANSITION_MODE/);
  assert.doesNotMatch(productionAppHosting, /NEXT_PUBLIC_PUFU_LENS_GRAPH_TRANSITION_MODE/);
  assert.doesNotMatch(exampleAppHosting, /NEXT_PUBLIC_PUFU_LENS_GRAPH_TRANSITION_MODE/);
});
