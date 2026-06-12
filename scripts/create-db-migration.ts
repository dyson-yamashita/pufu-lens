import { readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = resolveRepoRoot('infra/db/migrations');
const MIGRATION_FILENAME_PATTERN = /^(\d{4})_.+\.sql$/;

function resolveRepoRoot(path: string): string {
  return resolve(fileURLToPath(new URL('..', import.meta.url)), path);
}

function normalizeDescription(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

async function nextMigrationPrefix(migrationsDir: string): Promise<string> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  let maxPrefix = 0;

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) {
      continue;
    }

    const match = entry.name.match(MIGRATION_FILENAME_PATTERN);
    if (!match) {
      continue;
    }

    const prefix = match[1];
    if (!prefix) {
      continue;
    }

    maxPrefix = Math.max(maxPrefix, Number.parseInt(prefix, 10));
  }

  return String(maxPrefix + 1).padStart(4, '0');
}

function migrationTemplate(version: string): string {
  return `-- Migration: ${version}
-- Purpose:
-- Existing DB notes:
-- Fresh DB sync:
--   - Reflect the final schema in infra/docker/postgres/init.sql.
--   - Add this version to the schema_migrations baseline seed when init.sql includes it.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Do not include real personal data, OAuth tokens, API keys, or secrets.

-- DDL

-- Backfill

-- Validation
`;
}

export async function createMigration(description: string): Promise<string> {
  const normalizedDescription = normalizeDescription(description);
  if (!normalizedDescription) {
    throw new Error('migration description must contain at least one ASCII letter or digit.');
  }

  const prefix = await nextMigrationPrefix(MIGRATIONS_DIR);
  const version = `${prefix}_${normalizedDescription}`;
  const outputPath = resolve(MIGRATIONS_DIR, `${version}.sql`);

  await writeFile(outputPath, migrationTemplate(version), { flag: 'wx' });

  return outputPath;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const description = args.join(' ').trim();

  if (args.length === 0 || description === '--help' || description === '-h') {
    console.log('Usage: pnpm db:migration:new <description>');
    process.exit(0);
  }

  createMigration(description)
    .then((outputPath) => {
      console.log(`created ${outputPath}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
