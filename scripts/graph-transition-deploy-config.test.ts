import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
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
};

const CANONICAL_GRAPH_TRANSITION_MODES = ['off', 'dual-write', 'dual-write-shadow-read'] as const;

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
  assert.match(validateScript, /off\|dual-write\|dual-write-shadow-read\) ;;/);
  assert.match(
    validateScript,
    /echo "_GRAPH_TRANSITION_MODE must be off, dual-write, or dual-write-shadow-read\." >&2/,
  );
  assert.match(validateScript, /\*\)\s*\n\s*echo "_GRAPH_TRANSITION_MODE/);

  for (const mode of CANONICAL_GRAPH_TRANSITION_MODES) {
    assert.match(validateScript, new RegExp(mode.replace(/-/g, '\\-')));
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

test('production App Hosting declares runtime-only PUFU_LENS_GRAPH_TRANSITION_MODE dual-write', () => {
  const config = parseAppHostingConfig(productionAppHosting);
  const entry = findAppHostingEnvEntry(config, 'PUFU_LENS_GRAPH_TRANSITION_MODE');
  assert.ok(entry, 'PUFU_LENS_GRAPH_TRANSITION_MODE env entry is required');
  assert.equal(entry.value, 'dual-write');
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
