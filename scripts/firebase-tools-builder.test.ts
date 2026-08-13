import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TARGET = '    await provisionDefaultComputeServiceAccount(projectId);';
const EXPECTED_PATCH = `    if (process.env.PUFU_LENS_FIREBASE_SKIP_DEFAULT_COMPUTE_SA_PROVISIONING !== "true") {
        await provisionDefaultComputeServiceAccount(projectId);
    }`;
const patcherPath = fileURLToPath(
  new URL('../infra/docker/firebase-tools/patch-apphosting-compute-sa.mjs', import.meta.url),
);
const dockerfilePath = fileURLToPath(
  new URL('../infra/docker/firebase-tools/Dockerfile', import.meta.url),
);
const deployPath = fileURLToPath(
  new URL('../deploy/examples/gcp-cloud-build/cloudbuild.deploy.yaml', import.meta.url),
);

function runPatcher(fixturePath: string): { status: number | null; stderr: string } {
  try {
    execFileSync(process.execPath, [patcherPath, fixturePath], { stdio: 'pipe' });
    return { status: 0, stderr: '' };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      status?: number | null;
      stderr?: Buffer | string;
    };
    return {
      status: execError.status ?? null,
      stderr: execError.stderr?.toString() ?? '',
    };
  }
}

test('patcher replaces a single target statement with an environment-gated conditional', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'firebase-patcher-'));
  try {
    const fixturePath = join(dir, 'backend.js');
    const before = `async function deploy(projectId) {\n${TARGET}\n}\n`;
    await writeFile(fixturePath, before, 'utf8');

    const result = runPatcher(fixturePath);
    assert.equal(result.status, 0, result.stderr);

    const after = await readFile(fixturePath, 'utf8');
    assert.ok(
      after.includes(EXPECTED_PATCH),
      'patched snippet must match the exact multiline conditional indentation',
    );
    assert.match(after, /PUFU_LENS_FIREBASE_SKIP_DEFAULT_COMPUTE_SA_PROVISIONING !== "true"/);
    assert.match(after, /await provisionDefaultComputeServiceAccount\(projectId\);/);
    assert.equal(
      (after.match(/await provisionDefaultComputeServiceAccount\(projectId\);/g) ?? []).length,
      1,
    );
    assert.notEqual(after, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('patcher fails without modifying fixtures that lack the target statement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'firebase-patcher-'));
  try {
    const fixturePath = join(dir, 'backend.js');
    const before = 'async function deploy(projectId) {\n  await doSomethingElse(projectId);\n}\n';
    await writeFile(fixturePath, before, 'utf8');

    const result = runPatcher(fixturePath);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /found 0/);

    const after = await readFile(fixturePath, 'utf8');
    assert.equal(after, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('firebase-tools Dockerfile copies and runs the guarded patcher after install', async () => {
  const dockerfile = await readFile(dockerfilePath, 'utf8');
  assert.match(
    dockerfile,
    /COPY patch-apphosting-compute-sa\.mjs \/tmp\/patch-apphosting-compute-sa\.mjs/,
  );
  assert.match(
    dockerfile,
    /node \/tmp\/patch-apphosting-compute-sa\.mjs "\$\(npm root -g\)\/firebase-tools\/lib\/apphosting\/backend\.js"/,
  );
  assert.match(dockerfile, /rm \/tmp\/patch-apphosting-compute-sa\.mjs/);
});

test('Cloud Build App Hosting deploy scopes the compute SA provisioning opt-out', async () => {
  const deploy = await readFile(deployPath, 'utf8');
  const apphostingDeployLines = deploy
    .split('\n')
    .filter((line) => line.includes('firebase deploy --only apphosting'));

  assert.equal(apphostingDeployLines.length, 1);
  const [apphostingDeployLine] = apphostingDeployLines;
  assert.ok(apphostingDeployLine);
  assert.match(
    apphostingDeployLine,
    /PUFU_LENS_FIREBASE_SKIP_DEFAULT_COMPUTE_SA_PROVISIONING=true firebase deploy --only apphosting/,
  );
});
