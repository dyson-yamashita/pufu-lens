import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';

const repoRoot = join(import.meta.dirname, '../../..');

const directBoundaryModules = [
  'apps/web/src/chat.ts',
  'apps/web/src/graph-viewer.ts',
  'apps/web/src/private-chat-search.ts',
  'apps/web/src/report.ts',
  'apps/web/src/report-repository.ts',
  'packages/ingestion/src/graph-relations.ts',
];

const federatedReportAllowlist = new Set([
  'packages/activitypub/src/federated-report-repository.ts',
  'packages/activitypub/src/inbound-report-use-cases.ts',
  'packages/activitypub/src/federation-report-listeners.ts',
  'packages/activitypub/src/federation.ts',
  'packages/activitypub/src/follow-inbox-listener-harness.ts',
  'packages/activitypub/src/postgres.ts',
  'packages/activitypub/src/postgres-dispatcher.ts',
  'packages/activitypub/src/operations.ts',
  'packages/activitypub/src/remote-article.ts',
  'packages/activitypub/src/remote-document.ts',
  'packages/activitypub/src/inbound-report-sanitizer.ts',
  'packages/activitypub/src/schema.ts',
  'packages/activitypub/src/index.ts',
  'apps/web/src/federated-report-api.ts',
  'apps/web/src/federated-report-client.tsx',
  'apps/web/src/federated-report-response.ts',
  'apps/web/src/activitypub-runtime.ts',
  'apps/web/app/api/projects/[projectSlug]/federated-reports/route.ts',
  'apps/web/app/projects/[projectSlug]/reports/page.tsx',
  'scripts/activitypub-dispatch-once.ts',
]);

const federatedReferencePatterns = [
  /\bfederated_reports\b/,
  /\bFederatedReport\b/,
  /federated-report/,
  /federated-report-repository/,
  /inbound-report-use-cases/,
  /federation-report-listeners/,
];

function shouldSkipDirectory(name: string): boolean {
  return (
    name === 'node_modules' ||
    name.startsWith('.') ||
    name === 'dist' ||
    name === 'build' ||
    name === '.next'
  );
}

function shouldScanFile(relativePath: string): boolean {
  if (!relativePath.endsWith('.ts') && !relativePath.endsWith('.tsx')) {
    return false;
  }
  if (relativePath.endsWith('.test.ts') || relativePath.endsWith('.db.test.ts')) {
    return false;
  }
  if (relativePath.includes('/e2e/') || relativePath.includes('/dev/e2e/')) {
    return false;
  }
  if (relativePath.startsWith('packages/activitypub/src/hermetic-e2e/')) {
    return false;
  }
  if (
    !relativePath.startsWith('apps/') &&
    !relativePath.startsWith('packages/') &&
    !relativePath.startsWith('scripts/')
  ) {
    return false;
  }
  return true;
}

async function collectProductionSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        continue;
      }
      files.push(...(await collectProductionSourceFiles(join(directory, entry.name))));
      continue;
    }
    const fullPath = join(directory, entry.name);
    const relativePath = relative(repoRoot, fullPath);
    if (shouldScanFile(relativePath)) {
      files.push(relativePath);
    }
  }
  return files;
}

function referencesFederatedReports(source: string): boolean {
  return federatedReferencePatterns.some((pattern) => pattern.test(source));
}

test('chat graph embedding report generation and ingestion modules do not reference federated_reports storage', async () => {
  for (const relativePath of directBoundaryModules) {
    const source = await readFile(join(repoRoot, relativePath), 'utf8');
    assert.equal(
      source.includes('federated_reports'),
      false,
      `${relativePath} must not reference federated_reports`,
    );
    assert.equal(
      source.includes('FederatedReport'),
      false,
      `${relativePath} must not reference FederatedReport types`,
    );
  }
});

test('federated report references are limited to explicit allowlisted production modules', async () => {
  const files = await collectProductionSourceFiles(repoRoot);
  const offenders: string[] = [];
  for (const relativePath of files) {
    const source = await readFile(join(repoRoot, relativePath), 'utf8');
    if (!referencesFederatedReports(source)) {
      continue;
    }
    if (!federatedReportAllowlist.has(relativePath)) {
      offenders.push(relativePath);
    }
  }
  assert.deepEqual(
    offenders.sort(),
    [],
    `Unexpected federated report references: ${offenders.join(', ')}`,
  );
});

test('production source scan excludes only the ActivityPub hermetic harness directory', () => {
  assert.equal(shouldScanFile('packages/activitypub/src/hermetic-e2e/pufu-context.ts'), false);
  assert.equal(shouldScanFile('packages/activitypub/src/postgres.ts'), true);
});
