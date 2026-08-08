import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testRoot = fileURLToPath(new URL('../src', import.meta.url));

async function collectDbTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        return collectDbTestFiles(resolve(directory, entry.name));
      }

      return entry.isFile() && entry.name.endsWith('.db.test.ts')
        ? [resolve(directory, entry.name)]
        : [];
    }),
  );

  return files.flat();
}

async function runTestFile(testFile: string): Promise<number | null> {
  const child = spawn(process.execPath, ['--experimental-strip-types', testFile], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ACTIVITYPUB_RUN_DB_TESTS: '1',
      NODE_ENV: 'test',
    },
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

const testFiles = (await collectDbTestFiles(testRoot)).sort((a, b) => a.localeCompare(b));

if (testFiles.length === 0) {
  console.error('No database test files found under src/**/*.db.test.ts');
  process.exit(1);
}

for (const testFile of testFiles) {
  const displayPath = relative(process.cwd(), testFile);
  console.log(`\n> ${displayPath}`);

  const exitCode = await runTestFile(testFile);
  if (exitCode !== 0) {
    process.exit(exitCode ?? 1);
  }
}
