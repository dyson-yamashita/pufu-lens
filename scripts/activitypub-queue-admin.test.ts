import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

const adminScript = join(import.meta.dirname, 'activitypub-queue-admin.ts');

async function runQueueAdmin(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', adminScript, ...args], {
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

test('activitypub-queue-admin rejects mutation without execute confirmation', async () => {
  const messageId = '10000000-0000-4000-8000-000000000901';
  const { exitCode, stderr } = await runQueueAdmin(
    [
      'requeue',
      '--message-id',
      messageId,
      '--expected-updated-at',
      '2026-01-01T00:00:00.000Z',
      '--change-ref',
      'ticket-901',
    ],
    {
      ...process.env,
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/test',
    },
  );

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /activitypub_queue_admin_confirmation_required/);
  assert.doesNotMatch(stderr, /postgresql:\/\//);
});

test('activitypub-queue-admin rejects invalid change_ref before database access', async () => {
  const messageId = '10000000-0000-4000-8000-000000000903';
  const { exitCode, stderr } = await runQueueAdmin(
    [
      'requeue',
      '--execute',
      '--message-id',
      messageId,
      '--confirm-message-id',
      messageId,
      '--expected-updated-at',
      '2026-01-01T00:00:00.000Z',
      '--change-ref',
      'ops-db-test-requeue',
    ],
    {
      ...process.env,
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/test',
    },
  );

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /activitypub_queue_admin_invalid_arguments/);
});

test('activitypub-queue-admin rejects loose expected-updated-at timestamps', async () => {
  const messageId = '10000000-0000-4000-8000-000000000904';
  const { exitCode, stderr } = await runQueueAdmin(
    [
      'requeue',
      '--execute',
      '--message-id',
      messageId,
      '--confirm-message-id',
      messageId,
      '--expected-updated-at',
      '2026-01-01T00:00:00Z',
      '--change-ref',
      'ticket-904',
    ],
    {
      ...process.env,
      DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/test',
    },
  );

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /activitypub_queue_admin_invalid_arguments/);
});

test('activitypub-queue-admin rejects invalid UUID without leaking database URL', async () => {
  const { exitCode, stderr } = await runQueueAdmin(['inspect', '--message-id', 'not-a-uuid'], {
    ...process.env,
    DATABASE_URL: 'postgresql://user:super-secret@127.0.0.1:5432/test',
  });

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /activitypub_queue_admin_invalid_arguments/);
  assert.doesNotMatch(stderr, /super-secret/);
});

test('activitypub-queue-admin requires DATABASE_URL from env only', async () => {
  const { exitCode, stderr } = await runQueueAdmin(
    ['inspect', '--message-id', '10000000-0000-4000-8000-000000000902'],
    {
      ...process.env,
      DATABASE_URL: undefined,
    },
  );

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /missing DATABASE_URL/);
});
