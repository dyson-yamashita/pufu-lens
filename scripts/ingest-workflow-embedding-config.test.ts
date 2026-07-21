import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowSource = await readFile(new URL('./ingest-workflow.ts', import.meta.url), 'utf8');
const adminSource = await readFile(
  new URL('../apps/web/src/admin-data-source-actions.ts', import.meta.url),
  'utf8',
);

test('ingest workflow resolves one runtime embedding provider for logs and chunk execution', () => {
  assert.match(workflowSource, /resolveEmbeddingRuntimeConfig/);
  assert.match(
    workflowSource,
    /defaultProvider: 'deterministic',[\s\S]*env: process\.env,[\s\S]*provider: options\.embeddingProvider/,
  );
  assert.ok((workflowSource.match(/selectedEmbeddingProvider\(options\)/g) ?? []).length >= 3);
});

test('Cloud Run Admin workflow input does not duplicate the backend embedding provider', () => {
  const cloudRunWorkflow = adminSource.match(
    /async function runCloudRunIngestWorkflowJob[\s\S]*?async function/,
  )?.[0];
  assert.ok(cloudRunWorkflow);
  assert.doesNotMatch(cloudRunWorkflow, /embeddingProvider:/);
});
