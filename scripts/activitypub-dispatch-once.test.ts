import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

const dispatchScript = join(import.meta.dirname, 'activitypub-dispatch-once.ts');

async function runDispatchCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, ['--experimental-strip-types', dispatchScript, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });

  return { exitCode, stdout, stderr };
}

test('activitypub-dispatch-once reports safe errors without leaking database credentials', async () => {
  const embeddedSecret = 'super-secret-password-xyz';
  const databaseUrl = `postgresql://user:${embeddedSecret}@127.0.0.1:1/nope`;

  const { exitCode, stderr } = await runDispatchCli(
    [
      '--database-url',
      databaseUrl,
      '--actor-table',
      'activitypub_contract_test_actor_keys',
      '--actor-id',
      '10000000-0000-0000-0000-000000000667',
    ],
    {
      ...process.env,
      ACTIVITYPUB_RUN_DB_TESTS: '1',
    },
  );

  assert.notEqual(exitCode, 0);
  assert.doesNotMatch(stderr, new RegExp(embeddedSecret));
  assert.match(stderr, /activitypub_delivery_failed/);
});

test('activitypub-dispatch-once reports safe errors for malformed database URLs without leaking credentials', async () => {
  const embeddedSecret = 'malformed-url-secret-abc123';
  const databaseUrl = `postgresql://user:${embeddedSecret}@`;

  const { exitCode, stderr } = await runDispatchCli(
    [
      '--database-url',
      databaseUrl,
      '--actor-table',
      'activitypub_contract_test_actor_keys',
      '--actor-id',
      '10000000-0000-0000-0000-000000000667',
    ],
    {
      ...process.env,
      ACTIVITYPUB_RUN_DB_TESTS: '1',
    },
  );

  assert.notEqual(exitCode, 0);
  assert.doesNotMatch(stderr, new RegExp(embeddedSecret));
  assert.match(stderr, /activitypub_delivery_failed/);
});

test('activitypub-dispatch-once rejects actor arguments without ACTIVITYPUB_RUN_DB_TESTS', async () => {
  const { exitCode, stderr } = await runDispatchCli(
    [
      '--database-url',
      'postgresql://user:pass@127.0.0.1:5432/test',
      '--actor-table',
      'activitypub_contract_test_actor_keys',
      '--actor-id',
      '10000000-0000-0000-0000-000000000667',
    ],
    {
      ...process.env,
      ACTIVITYPUB_RUN_DB_TESTS: undefined,
    },
  );

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /ACTIVITYPUB_RUN_DB_TESTS/i);
  assert.doesNotMatch(stderr, /postgresql:\/\//);
});

test('activitypub-dispatch-once rejects production path without ACTIVITYPUB_CANONICAL_ORIGIN', async () => {
  const { exitCode, stderr } = await runDispatchCli(
    ['--database-url', 'postgresql://user:pass@127.0.0.1:5432/test'],
    {
      ...process.env,
      ACTIVITYPUB_CANONICAL_ORIGIN: undefined,
      ACTIVITYPUB_RUN_DB_TESTS: undefined,
      ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    },
  );

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /missing ACTIVITYPUB_CANONICAL_ORIGIN/i);
  assert.doesNotMatch(stderr, /postgresql:\/\//);
});

test('activitypub-dispatch-once rejects partial actor arguments on production path', async () => {
  const { exitCode, stderr } = await runDispatchCli(
    [
      '--database-url',
      'postgresql://user:pass@127.0.0.1:5432/test',
      '--actor-table',
      'activitypub_contract_test_actor_keys',
    ],
    {
      ...process.env,
      ACTIVITYPUB_RUN_DB_TESTS: undefined,
    },
  );

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /both --actor-table and --actor-id/i);
});
