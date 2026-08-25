import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GraphMigrationCliValidationError } from './graph-migration-cli-options.ts';

const execFileAsync = promisify(execFile);
const graphMigrationScript = fileURLToPath(new URL('../graph-migration.ts', import.meta.url));

test('graph-migration compare does not require object storage env vars', async () => {
  const env = {
    ...process.env,
    DATABASE_URL: 'postgresql://user:secret@localhost:5432/pufu_lens',
    GCS_BUCKET: undefined,
    LOCAL_STORAGE_ROOT: undefined,
    STORAGE_BACKEND: undefined,
  };
  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        ['--experimental-strip-types', graphMigrationScript, 'compare', '--project', 'sample-a'],
        { env },
      ),
    (error: NodeJS.ErrnoException & { stderr?: string }) => {
      assert.match(error.stderr ?? '', /Graph migration failed\./);
      assert.equal((error.stderr ?? '').includes('secret@localhost'), false);
      assert.equal((error.stderr ?? '').includes('postgresql://'), false);
      return true;
    },
  );
});

test('graph-migration preserves CLI validation messages separately from runtime failures', async () => {
  const { stderr } = await execFileAsync(
    process.execPath,
    ['--experimental-strip-types', graphMigrationScript, 'rebuild', '--project', 'sample-a'],
    {
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://ignored:ignored@localhost:5432/pufu_lens',
      },
    },
  ).catch((error: NodeJS.ErrnoException & { stderr?: string }) => {
    return { stderr: error.stderr ?? '' };
  });
  assert.match(stderr, /exactly one of --dry-run or --execute/);
});

test('graph-migration sanitizes runtime failures even when message resembles CLI validation text', async () => {
  const validationShapedRuntimeError = new Error(
    'rebuild requires exactly one of --dry-run or --execute.',
  );
  assert.equal(validationShapedRuntimeError instanceof GraphMigrationCliValidationError, false);

  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [
          '--experimental-strip-types',
          graphMigrationScript,
          'rebuild',
          '--project',
          'sample-a',
          '--dry-run',
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: 'postgresql://ignored:ignored@localhost:5432/pufu_lens',
          },
        },
      ),
    (error: NodeJS.ErrnoException & { stderr?: string }) => {
      const stderr = error.stderr ?? '';
      assert.match(stderr, /Graph migration failed\./);
      assert.equal(/exactly one of --dry-run or --execute/.test(stderr), false);
      return true;
    },
  );
});
