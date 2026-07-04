import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testRoot = fileURLToPath(new URL('../src', import.meta.url));

async function collectTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return collectTestFiles(fullPath);
      }

      return entry.isFile() && entry.name.endsWith('.test.ts') ? [fullPath] : [];
    }),
  );

  return files.flat();
}

async function runTestFile(testFile: string): Promise<number | null> {
  const child = spawn(process.execPath, ['--experimental-strip-types', testFile], {
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

const testFiles = (await collectTestFiles(testRoot)).sort((a, b) => a.localeCompare(b));

if (testFiles.length === 0) {
  console.error('No test files found under src/**/*.test.ts');
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
