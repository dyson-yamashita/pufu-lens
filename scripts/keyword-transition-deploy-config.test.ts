import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const productionAppHosting = parseYaml(
  await readFile(productionAppHostingPath, 'utf8'),
) as AppHostingConfig;
const exampleAppHosting = parseYaml(
  await readFile(exampleAppHostingPath, 'utf8'),
) as AppHostingConfig;

type AppHostingEnvEntry = {
  readonly availability?: readonly string[];
  readonly secret?: string;
  readonly value?: string;
  readonly variable: string;
};

type AppHostingConfig = { readonly env?: readonly AppHostingEnvEntry[] };

function findEntry(config: AppHostingConfig, variable: string): AppHostingEnvEntry | undefined {
  return config.env?.find((entry) => entry.variable === variable);
}

function extractStepScript(yaml: string, stepId: string): string {
  const stepStart = yaml.indexOf(`- id: ${stepId}`);
  assert.notEqual(stepStart, -1, `missing step ${stepId}`);
  const nextStepStart = yaml.indexOf('\n  - id: ', stepStart + 1);
  const block = nextStepStart === -1 ? yaml.slice(stepStart) : yaml.slice(stepStart, nextStepStart);
  const script = block.match(/args:\s*\n\s*- -c\s*\n\s*- \|\s*\n([\s\S]*)/);
  assert.ok(script?.[1], `missing script for ${stepId}`);
  return script[1];
}

test('keyword deployment defaults keep PGroonga primary and pass one server-owned mode', () => {
  const parsed = parseYaml(deployYaml) as { substitutions?: Record<string, string> };
  assert.equal(parsed.substitutions?._KEYWORD_TRANSITION_MODE, 'pgroonga-primary');
  assert.match(deployYaml, /PUFU_LENS_KEYWORD_TRANSITION_MODE=\$\{_KEYWORD_TRANSITION_MODE\}/);
  assert.match(deployYaml, /id: validate-production-keyword-mode/);
  assert.match(
    deployYaml,
    /- id: validate-deploy-substitutions[\s\S]*?waitFor:\s*\n\s+- validate-production-graph-mode\n\s+- validate-production-keyword-mode/,
  );

  const productionEntry = findEntry(productionAppHosting, 'PUFU_LENS_KEYWORD_TRANSITION_MODE');
  assert.deepEqual(productionEntry, {
    variable: 'PUFU_LENS_KEYWORD_TRANSITION_MODE',
    value: 'pgroonga-primary',
    availability: ['RUNTIME'],
  });
  const exampleEntry = findEntry(exampleAppHosting, 'PUFU_LENS_KEYWORD_TRANSITION_MODE');
  assert.deepEqual(exampleEntry, {
    variable: 'PUFU_LENS_KEYWORD_TRANSITION_MODE',
    value: 'pgroonga-primary',
    availability: ['RUNTIME'],
  });
});

test('Cloud Build substitution validation accepts only the three keyword transition modes', () => {
  const script = extractStepScript(deployYaml, 'validate-deploy-substitutions');
  const block = script.match(/case "\$\{_KEYWORD_TRANSITION_MODE\}" in[\s\S]*?esac/)?.[0];
  assert.ok(block);
  assert.match(
    script,
    /_KEYWORD_TRANSITION_MODE must be pgroonga-primary, pgroonga-shadow, or portable-primary\./,
  );
  for (const value of ['pgroonga-primary', 'pgroonga-shadow', 'portable-primary', '', 'unknown']) {
    const result: ReturnType<typeof spawnSync> = spawnSync('bash', ['-c', block], {
      env: { ...process.env, _KEYWORD_TRANSITION_MODE: value },
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      value === 'pgroonga-primary' || value === 'pgroonga-shadow' || value === 'portable-primary'
        ? 0
        : 1,
      value,
    );
  }
});

test('production keyword guard fails closed on mismatch, malformed, secret, or missing runtime config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keyword-mode-'));
  const configPath = join(root, 'apps/web/apphosting.yaml');
  const scriptPath = fileURLToPath(
    new URL('./validate-production-keyword-mode.cjs', import.meta.url),
  );
  await mkdir(join(root, 'apps/web'), { recursive: true });
  try {
    const fixture = (mode: string) =>
      `env:\n  - variable: PUFU_LENS_KEYWORD_TRANSITION_MODE\n    value: '${mode}'\n    availability: [RUNTIME]\n`;
    const cases = [
      { yaml: fixture('pgroonga-primary'), mode: 'pgroonga-primary', ok: true },
      { yaml: fixture('pgroonga-shadow'), mode: 'pgroonga-shadow', ok: true },
      { yaml: fixture('portable-primary'), mode: 'portable-primary', ok: true },
      { yaml: fixture('pgroonga-primary'), mode: 'portable-primary', ok: false },
      { yaml: fixture('unknown'), mode: 'unknown', ok: false },
      { yaml: 'env: []', mode: 'pgroonga-primary', ok: false },
      {
        yaml: fixture('pgroonga-primary').replace('[RUNTIME]', '[BUILD]'),
        mode: 'pgroonga-primary',
        ok: false,
      },
      {
        yaml: `${fixture('pgroonga-primary')}    secret: keyword-mode\n`,
        mode: 'pgroonga-primary',
        ok: false,
      },
      { yaml: 'env: [', mode: 'pgroonga-primary', ok: false },
    ];
    for (const entry of cases) {
      await writeFile(configPath, entry.yaml);
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: root,
        env: { ...process.env, DEPLOY_ENV: 'production', KEYWORD_TRANSITION_MODE: entry.mode },
        encoding: 'utf8',
      });
      assert.equal(result.status, entry.ok ? 0 : 1, `${entry.yaml}: ${result.stderr}`);
    }
    await writeFile(configPath, fixture('pgroonga-primary'));
    const nonProduction = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, DEPLOY_ENV: 'staging', KEYWORD_TRANSITION_MODE: 'unknown' },
      encoding: 'utf8',
    });
    assert.equal(nonProduction.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
