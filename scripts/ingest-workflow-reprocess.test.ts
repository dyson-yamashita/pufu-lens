import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runJsonLineScript } from './lib/script-test-runner.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ingestWorkflowScript = join(repoRoot, 'scripts/ingest-workflow.ts');

test('reprocess dry-run requires DATABASE_URL before querying candidates', async () => {
  const result = await runJsonLineScript({
    args: ['reprocess', '--project', 'sample-a', '--source', 'github', '--dry-run', '--limit', '3'],
    cwd: repoRoot,
    env: { DATABASE_URL: undefined },
    scriptPath: ingestWorkflowScript,
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /DATABASE_URL/);
});

test('reprocess rejects missing apply and dry-run flags', async () => {
  const result = await runJsonLineScript({
    args: ['reprocess', '--project', 'sample-a', '--source', 'github'],
    cwd: repoRoot,
    env: { DATABASE_URL: 'postgresql://example.invalid/pufu_lens' },
    scriptPath: ingestWorkflowScript,
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /requires --apply or --dry-run/);
});

test('reprocess dry-run does not print secret-like workflow output', async () => {
  const result = await runJsonLineScript({
    args: [
      'reprocess',
      '--project',
      'sample-a',
      '--source',
      'github',
      '--dry-run',
      '--drain',
      '--resume-from',
      'parse',
      '--limit',
      '2',
    ],
    cwd: repoRoot,
    env: { DATABASE_URL: undefined },
    scriptPath: ingestWorkflowScript,
  });

  assert.notEqual(result.exitCode, 0);
  const emitted = `${result.stderr}\n${JSON.stringify(result.events)}`;
  assert.doesNotMatch(emitted, /comment-only|token=|GEMINI_API_KEY/);
});

test('reprocess apply without database URL fails before mutation', async () => {
  const result = await runJsonLineScript({
    args: ['reprocess', '--project', 'sample-a', '--source', 'github', '--apply', '--limit', '1'],
    cwd: repoRoot,
    env: { DATABASE_URL: undefined },
    scriptPath: ingestWorkflowScript,
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /DATABASE_URL/);
});
