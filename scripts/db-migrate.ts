import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

const MIGRATIONS_DIR = resolveRepoRoot('infra/db/migrations');
const MIGRATION_LOCK_KEY = 'pufu_lens_schema_migrations';

export const MIGRATION_FILENAME_PATTERN = /^\d{4}_.+\.sql$/;

export type MigrationEntry = {
  filename: string;
  prefix: string;
  version: string;
};

export type MigrationValidationIssue = {
  code:
    | 'duplicate_prefix'
    | 'duplicate_version'
    | 'empty_directory'
    | 'invalid_filename'
    | 'missing_migration_file';
  message: string;
};

export class MigrationValidationError extends Error {
  readonly issues: readonly MigrationValidationIssue[];

  constructor(issues: readonly MigrationValidationIssue[]) {
    super('migration validation failed');
    this.name = 'MigrationValidationError';
    this.issues = issues;
  }
}

export function parseMigrationFilename(
  filename: string,
): { prefix: string; version: string } | null {
  if (!MIGRATION_FILENAME_PATTERN.test(filename)) {
    return null;
  }

  return {
    prefix: filename.slice(0, 4),
    version: basename(filename, '.sql'),
  };
}

export function validateMigrationFilenames(
  filenames: readonly string[],
): MigrationValidationIssue[] {
  if (filenames.length === 0) {
    return [
      {
        code: 'empty_directory',
        message: 'migration directory is empty.',
      },
    ];
  }

  const issues: MigrationValidationIssue[] = [];
  const validEntries: MigrationEntry[] = [];

  for (const filename of filenames) {
    const parsed = parseMigrationFilename(filename);
    if (!parsed) {
      issues.push({
        code: 'invalid_filename',
        message: `invalid migration filename: ${filename} (expected NNNN_short_description.sql)`,
      });
      continue;
    }

    validEntries.push({
      filename,
      prefix: parsed.prefix,
      version: parsed.version,
    });
  }

  const versions = new Map<string, string[]>();
  for (const entry of validEntries) {
    const files = versions.get(entry.version) ?? [];
    files.push(entry.filename);
    versions.set(entry.version, files);
  }

  for (const [version, files] of versions) {
    if (files.length > 1) {
      issues.push({
        code: 'duplicate_version',
        message: `duplicate migration version ${version}: ${files.join(', ')}`,
      });
    }
  }

  const prefixes = new Map<string, string[]>();
  for (const entry of validEntries) {
    const files = prefixes.get(entry.prefix) ?? [];
    files.push(entry.filename);
    prefixes.set(entry.prefix, files);
  }

  for (const [prefix, files] of prefixes) {
    if (files.length > 1) {
      issues.push({
        code: 'duplicate_prefix',
        message: `duplicate migration prefix ${prefix}: ${files.join(', ')}`,
      });
    }
  }

  return issues;
}

export async function discoverMigrationFilenames(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

export async function validateMigrationsDirectory(
  migrationsDir: string,
): Promise<MigrationValidationIssue[]> {
  const filenames = await discoverMigrationFilenames(migrationsDir);
  return validateMigrationFilenames(filenames);
}

export function partitionMigrations(
  migrations: readonly { version: string }[],
  appliedVersions: readonly string[],
): { applied: string[]; pending: string[] } {
  const appliedSet = new Set(appliedVersions);
  const applied: string[] = [];
  const pending: string[] = [];

  for (const migration of migrations) {
    if (appliedSet.has(migration.version)) {
      applied.push(migration.version);
    } else {
      pending.push(migration.version);
    }
  }

  return { applied, pending };
}

export function findMissingMigrationFiles(
  migrationVersions: readonly string[],
  appliedVersions: readonly string[],
): string[] {
  const migrationSet = new Set(migrationVersions);
  return appliedVersions.filter((version) => !migrationSet.has(version));
}

export async function migrateDatabase(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  const validationIssues = await validateMigrationsDirectory(MIGRATIONS_DIR);
  if (validationIssues.length > 0) {
    throw new MigrationValidationError(validationIssues);
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`SELECT pg_advisory_lock(hashtext(${MIGRATION_LOCK_KEY}))`;
    await ensureSchemaMigrationsTable(sql);

    const migrations = await listMigrations();
    for (const migration of migrations) {
      const applied = await isMigrationApplied(sql, migration.version);
      if (applied) {
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx`
          INSERT INTO public.schema_migrations (version)
          VALUES (${migration.version})
        `;
      });
      console.log(`applied migration ${migration.version}`);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext(${MIGRATION_LOCK_KEY}))`.catch(() => []);
    await sql.end();
  }
}

export async function planMigrations(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for --plan.');
  }

  const validationIssues = await validateMigrationsDirectory(MIGRATIONS_DIR);
  if (validationIssues.length > 0) {
    throw new MigrationValidationError(validationIssues);
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await ensureSchemaMigrationsTable(sql);
    const migrations = await listMigrations();
    const appliedVersions = await getAppliedVersions(sql);
    const { pending } = partitionMigrations(migrations, appliedVersions);

    if (pending.length === 0) {
      console.log('no pending migrations');
      return;
    }

    for (const version of pending) {
      console.log(`pending ${version}`);
    }
  } finally {
    await sql.end();
  }
}

export async function listMigrationStatus(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for --list.');
  }

  const validationIssues = await validateMigrationsDirectory(MIGRATIONS_DIR);
  if (validationIssues.length > 0) {
    throw new MigrationValidationError(validationIssues);
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await ensureSchemaMigrationsTable(sql);
    const migrations = await listMigrations();
    const appliedVersions = await getAppliedVersions(sql);
    const { applied, pending } = partitionMigrations(migrations, appliedVersions);

    console.log('applied migrations:');
    if (applied.length === 0) {
      console.log('  (none)');
    } else {
      for (const version of applied) {
        console.log(`  ${version}`);
      }
    }

    console.log('pending migrations:');
    if (pending.length === 0) {
      console.log('  (none)');
    } else {
      for (const version of pending) {
        console.log(`  ${version}`);
      }
    }
  } finally {
    await sql.end();
  }
}

export async function checkMigrations(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  const issues = await validateMigrationsDirectory(MIGRATIONS_DIR);

  if (databaseUrl) {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await ensureSchemaMigrationsTable(sql);
      const migrations = await listMigrations();
      const appliedVersions = await getAppliedVersions(sql);
      const missingVersions = findMissingMigrationFiles(
        migrations.map((migration) => migration.version),
        appliedVersions,
      );

      for (const version of missingVersions) {
        issues.push({
          code: 'missing_migration_file',
          message: `applied migration ${version} is missing from migration files`,
        });
      }
    } finally {
      await sql.end();
    }
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(issue.message);
    }
    throw new MigrationValidationError(issues);
  }

  console.log('migration check passed');
}

async function listMigrations(
  migrationsDir = MIGRATIONS_DIR,
): Promise<readonly { sql: string; version: string }[]> {
  const filenames = (await discoverMigrationFilenames(migrationsDir)).filter((filename) =>
    MIGRATION_FILENAME_PATTERN.test(filename),
  );

  return Promise.all(
    filenames.map(async (file) => ({
      sql: await readFile(resolve(migrationsDir, file), 'utf8'),
      version: basename(file, '.sql'),
    })),
  );
}

async function ensureSchemaMigrationsTable(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function getAppliedVersions(sql: postgres.Sql): Promise<string[]> {
  const rows = (await sql`
    SELECT version
    FROM public.schema_migrations
    ORDER BY version
  `) as Array<{ version: string }>;
  return rows.map((row) => row.version);
}

async function isMigrationApplied(sql: postgres.Sql, version: string): Promise<boolean> {
  const rows = (await sql`
    SELECT version
    FROM public.schema_migrations
    WHERE version = ${version}
  `) as Array<{ version: string }>;
  return Boolean(rows[0]);
}

function resolveRepoRoot(...paths: readonly string[]): string {
  return resolve(fileURLToPath(new URL('..', import.meta.url)), ...paths);
}

export function parseCliMode(argv: readonly string[]): 'check' | 'list' | 'migrate' | 'plan' {
  const supportedFlags = new Set(['--check', '--list', '--plan']);
  const unknownArgs = argv.filter((arg) => !supportedFlags.has(arg));
  if (unknownArgs.length > 0) {
    throw new Error(`unknown CLI option or argument: ${unknownArgs.join(', ')}`);
  }

  const modes = [...new Set(argv)];
  if (modes.length > 1) {
    throw new Error(`conflicting CLI modes: ${modes.join(', ')}`);
  }

  if (modes.includes('--plan')) {
    return 'plan';
  }
  if (modes.includes('--list')) {
    return 'list';
  }
  if (modes.includes('--check')) {
    return 'check';
  }

  return 'migrate';
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const mode = parseCliMode(argv);

  switch (mode) {
    case 'plan':
      await planMigrations();
      break;
    case 'list':
      await listMigrationStatus();
      break;
    case 'check':
      await checkMigrations();
      break;
    default:
      await migrateDatabase();
      console.log('database migrations completed');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await runCli();
  } catch (error) {
    if (error instanceof MigrationValidationError) {
      for (const issue of error.issues) {
        console.error(issue.message);
      }
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}
