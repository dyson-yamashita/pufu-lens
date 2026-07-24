import { spawn } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webTestRoot = fileURLToPath(new URL('../src', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error('DATABASE_URL is required for database integration tests.');
  process.exit(1);
}

const dbTestFiles = [
  resolve(webTestRoot, 'postgres-roundtrip.test.ts'),
  resolve(webTestRoot, 'admin-report-schedule-runtime.test.ts'),
  resolve(webTestRoot, 'actor-merge-db.test.ts'),
  resolve(webTestRoot, 'graph-coverage-db.test.ts'),
  resolve(repoRoot, 'scripts/lib/built-in-parser-profiles-db.test.ts'),
  resolve(repoRoot, 'scripts/lib/ingest-workflow-reprocess-db.test.ts'),
];

async function runTestFile(testFile: string): Promise<number | null> {
  const child = spawn(process.execPath, ['--experimental-strip-types', testFile], {
    env: process.env,
    stdio: 'inherit',
  });

  return new Promise((resolveProcess, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        console.error(`Test process terminated by signal: ${signal}`);
        resolveProcess(1);
        return;
      }

      resolveProcess(code);
    });
  });
}

for (const testFile of dbTestFiles) {
  const displayPath = relative(process.cwd(), testFile);
  console.log(`\n> ${displayPath}`);

  const exitCode = await runTestFile(testFile);
  if (exitCode !== 0) {
    process.exit(exitCode ?? 1);
  }
}

console.log('web database integration tests passed');
