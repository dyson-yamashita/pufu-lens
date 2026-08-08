import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  FEDIFY_PINNED_VERSION,
  FEDIFY_SECURITY_VERSION_FLOORS,
  NODE_RUNTIME_MIN_MAJOR,
} from './dependency-metadata.ts';

const repoRoot = join(import.meta.dirname, '../../..');

const fedifyPackages = [
  '@fedify/fedify',
  '@fedify/next',
  '@fedify/postgres',
  '@fedify/vocab',
  '@fedify/vocab-runtime',
] as const;

test('dependency metadata exports pinned Fedify version and security floors', () => {
  assert.equal(FEDIFY_PINNED_VERSION, '2.3.4');
  assert.deepEqual(FEDIFY_SECURITY_VERSION_FLOORS, {
    '@fedify/vocab-runtime': '2.2.4',
    '@fedify/fedify': '2.3.2',
  });
  assert.equal(NODE_RUNTIME_MIN_MAJOR, 22);
});

test('Fedify packages are pinned to 2.3.4 in manifests and workspace overrides', async () => {
  const [activitypubPackage, webPackage, workspaceYaml, rootPackage] = await Promise.all([
    readFile(join(repoRoot, 'packages/activitypub/package.json'), 'utf8').then(JSON.parse),
    readFile(join(repoRoot, 'apps/web/package.json'), 'utf8').then(JSON.parse),
    readFile(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
    readFile(join(repoRoot, 'package.json'), 'utf8').then(JSON.parse),
  ]);

  for (const packageName of fedifyPackages) {
    assert.equal(
      activitypubPackage.dependencies?.[packageName] ??
        activitypubPackage.devDependencies?.[packageName],
      FEDIFY_PINNED_VERSION,
      `${packageName} must be pinned in @pufu-lens/activitypub`,
    );
    assert.match(
      workspaceYaml,
      workspaceOverridePattern(packageName),
      `${packageName} override missing in pnpm-workspace.yaml`,
    );
  }

  assert.equal(webPackage.dependencies['@fedify/next'], FEDIFY_PINNED_VERSION);
  assert.equal(webPackage.dependencies['@pufu-lens/activitypub'], 'workspace:*');
  assert.ok(rootPackage.engines?.node?.includes('22'), 'root package.json must require Node >=22');
});

test('Fedify 2.3 line security floor rejects vulnerable 2.3.0 and 2.3.1 patch releases', () => {
  const floor = FEDIFY_SECURITY_VERSION_FLOORS['@fedify/fedify'];
  assert.equal(floor, '2.3.2');
  for (const version of ['2.3.0', '2.3.1']) {
    assert.ok(
      compareSemver(version, floor) < 0,
      `${version} must be below security floor ${floor}`,
    );
  }
  assert.ok(
    compareSemver(FEDIFY_PINNED_VERSION, floor) >= 0,
    `${FEDIFY_PINNED_VERSION} must satisfy security floor ${floor}`,
  );
});

test('pnpm-lock.yaml resolves Fedify packages at or above security floors', async () => {
  const lockfile = await readFile(join(repoRoot, 'pnpm-lock.yaml'), 'utf8');

  for (const packageName of fedifyPackages) {
    assert.match(
      lockfile,
      lockfileSnapshotPattern(packageName),
      `${packageName} must resolve to 2.3.4 in lockfile`,
    );
  }

  for (const [packageName, floor] of Object.entries(FEDIFY_SECURITY_VERSION_FLOORS) as Array<
    [string, string]
  >) {
    for (const version of collectLockfilePackageVersions(lockfile, packageName)) {
      assert.ok(
        compareSemver(version, floor) >= 0,
        `${packageName} resolved to ${version}, below security floor ${floor}`,
      );
    }
  }
});

function workspaceOverridePattern(packageName: string): RegExp {
  const escaped = packageName.replace('/', '\\/');
  return new RegExp(`^\\s*'${escaped}':\\s*2\\.3\\.4\\s*$`, 'm');
}

function lockfileSnapshotPattern(packageName: string): RegExp {
  const escaped = packageName.replace('/', '\\/');
  return new RegExp(`^  '${escaped}@2\\.3\\.4':`, 'm');
}

function collectLockfilePackageVersions(lockfile: string, packageName: string): string[] {
  const escaped = packageName.replace('/', '\\/');
  const pattern = new RegExp(`^  '${escaped}@([^']+)':`, 'gm');
  const versions = new Set<string>();
  for (const match of lockfile.matchAll(pattern)) {
    const spec = match[1];
    if (!spec) {
      continue;
    }
    const version = spec.split('(')[0];
    if (version) {
      versions.add(version);
    }
  }
  return [...versions];
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number(part));
  const rightParts = right.split('.').map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}
