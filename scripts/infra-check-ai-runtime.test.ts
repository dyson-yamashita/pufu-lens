import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const infraCheckScript = join(repoRoot, 'scripts/infra-check.ts');

const BASE_ENV = {
  ANTHROPIC_API_KEY_SECRET: 'ANTHROPIC_API_KEY',
  ARTIFACT_REGISTRY_REPOSITORY: 'pufu-lens',
  DATABASE_URL_SECRET: 'DATABASE_URL',
  GCP_PROJECT: 'test-project',
  GCP_REGION: 'asia-east1',
  GEMINI_API_KEY_SECRET: 'GEMINI_API_KEY',
  MASTRA_RUNTIME_SERVICE_ACCOUNT: 'mastra@test-project.iam.gserviceaccount.com',
  MASTRA_SERVER_URL: 'https://mastra.example.test',
  OPENAI_API_KEY_SECRET: 'OPENAI_API_KEY',
  PUFU_LENS_EMBEDDING_API_KEY_SECRET: '',
  PUFU_LENS_CHAT_MODEL: 'openai/gpt-test',
  PUFU_LENS_EMBEDDING_DIMENSIONS: '1536',
  PUFU_LENS_EMBEDDING_MODEL: 'gemini-embedding-test',
  PUFU_LENS_EMBEDDING_PROVIDER: 'gemini',
  SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test-project.iam.gserviceaccount.com',
  STORAGE_BUCKET: 'test-bucket',
  VPC_CONNECTOR: 'test-connector',
} as const;

test('infra check accepts supported independent Chat and Embedding providers', async () => {
  const result = await runInfraCheck({});

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.status, 'passed');
  assert.equal(result.output.aiRuntime.status, 'passed');
});

test('infra check blocks unsupported Chat and Embedding providers', async () => {
  const invalidChat = await runInfraCheck({ PUFU_LENS_CHAT_MODEL: 'unknown/model' });
  const invalidEmbedding = await runInfraCheck({
    PUFU_LENS_EMBEDDING_API_KEY_SECRET: 'UNKNOWN_API_KEY',
    PUFU_LENS_EMBEDDING_PROVIDER: 'unknown',
  });

  assert.equal(invalidChat.exitCode, 1);
  assert.equal(invalidChat.output.aiRuntime.status, 'blocked');
  assert.equal(invalidEmbedding.exitCode, 1);
  assert.equal(invalidEmbedding.output.aiRuntime.status, 'blocked');
});

test('infra check blocks incomplete Chat model IDs and incompatible vector dimensions', async () => {
  const incompleteChat = await runInfraCheck({ PUFU_LENS_CHAT_MODEL: 'openai/' });
  const invalidDimensions = await runInfraCheck({ PUFU_LENS_EMBEDDING_DIMENSIONS: '3072' });

  assert.equal(incompleteChat.exitCode, 1);
  assert.equal(incompleteChat.output.aiRuntime.status, 'blocked');
  assert.equal(invalidDimensions.exitCode, 1);
  assert.equal(invalidDimensions.output.aiRuntime.status, 'blocked');
});

async function runInfraCheck(overrides: Record<string, string>): Promise<{
  exitCode: number | null;
  output: {
    aiRuntime: { status: string };
    status: string;
  };
}> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', infraCheckScript, '--env', 'staging'],
    {
      cwd: repoRoot,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...BASE_ENV, ...overrides },
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(stderr, '');
  return {
    exitCode,
    output: JSON.parse(stdout) as {
      aiRuntime: { status: string };
      status: string;
    },
  };
}
