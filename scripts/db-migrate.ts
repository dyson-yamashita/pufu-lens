import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

const MIGRATIONS_DIR = resolveRepoRoot('infra/db/migrations');
const MIGRATION_LOCK_KEY = 'pufu_lens_schema_migrations';

export async function migrateDatabase(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`SELECT pg_advisory_lock(hashtext(${MIGRATION_LOCK_KEY}))`;
    await sql`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

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

async function listMigrations(): Promise<readonly { sql: string; version: string }[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(
    files.map(async (file) => ({
      sql: await readFile(resolve(MIGRATIONS_DIR, file), 'utf8'),
      version: basename(file, '.sql'),
    })),
  );
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await migrateDatabase();
  console.log('database migrations completed');
}
