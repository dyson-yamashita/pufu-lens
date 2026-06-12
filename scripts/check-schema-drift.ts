import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { migrateDatabase } from './db-migrate.ts';

const INIT_SQL_PATH = resolveRepoRoot('infra/docker/postgres/init.sql');
const BASELINE_SQL_PATH = resolveRepoRoot('infra/db/baseline/0000_baseline.sql');

type SchemaItem = {
  key: string;
  value: string;
};

type Drift = {
  fresh: string | null;
  key: string;
  migrated: string | null;
};

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  const suffix = `${process.pid}_${Date.now().toString(36)}`;
  const freshDbName = `pufu_drift_fresh_${suffix}`;
  const migratedDbName = `pufu_drift_migrated_${suffix}`;
  const adminSql = postgres(databaseUrlFor(databaseUrl, 'postgres'), { max: 1 });

  try {
    await createDatabase(adminSql, freshDbName);
    await createDatabase(adminSql, migratedDbName);

    const freshUrl = databaseUrlFor(databaseUrl, freshDbName);
    const migratedUrl = databaseUrlFor(databaseUrl, migratedDbName);

    await applySqlFile(freshUrl, INIT_SQL_PATH, freshDbName);
    await applySqlFile(migratedUrl, BASELINE_SQL_PATH, migratedDbName);
    await migrateDatabase(migratedUrl);

    const [freshSnapshot, migratedSnapshot] = await Promise.all([
      snapshotSchema(freshUrl),
      snapshotSchema(migratedUrl),
    ]);
    const drift = diffSnapshots(freshSnapshot, migratedSnapshot);

    if (drift.length > 0) {
      console.error('schema drift detected between init.sql and baseline + migrations');
      for (const item of drift) {
        console.error(`- ${item.key}`);
        if (item.fresh === null) {
          console.error(`  fresh:   (missing)`);
        } else {
          console.error(`  fresh:   ${item.fresh}`);
        }
        if (item.migrated === null) {
          console.error(`  migrated: (missing)`);
        } else {
          console.error(`  migrated: ${item.migrated}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    console.log('schema drift check passed');
  } finally {
    await dropDatabase(adminSql, freshDbName).catch(() => undefined);
    await dropDatabase(adminSql, migratedDbName).catch(() => undefined);
    await adminSql.end();
  }
}

async function createDatabase(sql: postgres.Sql, databaseName: string): Promise<void> {
  await sql.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
}

async function dropDatabase(sql: postgres.Sql, databaseName: string): Promise<void> {
  try {
    await sql.unsafe(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${quoteLiteral(databaseName)}
        AND pid <> pg_backend_pid()
    `);
  } catch {
    // Some environments lack pg_signal_backend; still try DROP DATABASE below.
  }
  await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
}

async function applySqlFile(
  databaseUrl: string,
  sqlPath: string,
  databaseName: string,
): Promise<void> {
  const sqlText = await readFile(sqlPath, 'utf8');
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(rewriteDatabaseName(sqlText, databaseName));
  } finally {
    await sql.end();
  }
}

function rewriteDatabaseName(sqlText: string, databaseName: string): string {
  return sqlText.replace(
    /ALTER\s+DATABASE\s+pufu_lens\s+SET\s+search_path/gi,
    `ALTER DATABASE ${quoteIdentifier(databaseName)} SET search_path`,
  );
}

async function snapshotSchema(databaseUrl: string): Promise<Map<string, string>> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = [
      ...(await snapshotExtensions(sql)),
      ...(await snapshotTables(sql)),
      ...(await snapshotColumns(sql)),
      ...(await snapshotConstraints(sql)),
      ...(await snapshotIndexes(sql)),
      ...(await snapshotTriggers(sql)),
      ...(await snapshotSchemaMigrations(sql)),
    ];
    return new Map(rows.map((row) => [row.key, row.value]));
  } finally {
    await sql.end();
  }
}

async function snapshotExtensions(sql: postgres.Sql): Promise<SchemaItem[]> {
  return sql<SchemaItem[]>`
    SELECT
      'extension:' || extname AS key,
      extname || ':' || extversion AS value
    FROM pg_extension
    WHERE extname <> 'plpgsql'
    ORDER BY extname
  `;
}

async function snapshotTables(sql: postgres.Sql): Promise<SchemaItem[]> {
  return sql<SchemaItem[]>`
    SELECT
      'table:' || n.nspname || '.' || c.relname AS key,
      c.relkind::text AS value
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
    ORDER BY n.nspname, c.relname
  `;
}

async function snapshotColumns(sql: postgres.Sql): Promise<SchemaItem[]> {
  return sql<SchemaItem[]>`
    SELECT
      'column:' || table_schema || '.' || table_name || '.' || column_name AS key,
      concat_ws(
        '|',
        udt_schema || '.' || udt_name,
        data_type,
        is_nullable,
        COALESCE(column_default, ''),
        COALESCE(character_maximum_length::text, ''),
        COALESCE(numeric_precision::text, ''),
        COALESCE(numeric_scale::text, '')
      ) AS value
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_schema, table_name, ordinal_position
  `;
}

async function snapshotConstraints(sql: postgres.Sql): Promise<SchemaItem[]> {
  return sql<SchemaItem[]>`
    SELECT
      'constraint:' || n.nspname || '.' || c.relname || '.' || con.conname AS key,
      con.contype::text || '|' || pg_get_constraintdef(con.oid, true) AS value
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY n.nspname, c.relname, con.conname
  `;
}

async function snapshotIndexes(sql: postgres.Sql): Promise<SchemaItem[]> {
  return sql<SchemaItem[]>`
    SELECT
      'index:' || schemaname || '.' || tablename || '.' || indexname AS key,
      indexdef AS value
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY schemaname, tablename, indexname
  `;
}

async function snapshotTriggers(sql: postgres.Sql): Promise<SchemaItem[]> {
  return sql<SchemaItem[]>`
    SELECT
      'trigger:' || event_object_schema || '.' || event_object_table || '.' || trigger_name AS key,
      action_timing || '|' || event_manipulation || '|' || action_statement AS value
    FROM information_schema.triggers
    WHERE event_object_schema = 'public'
    ORDER BY event_object_schema, event_object_table, trigger_name, event_manipulation
  `;
}

async function snapshotSchemaMigrations(sql: postgres.Sql): Promise<SchemaItem[]> {
  const rows = await sql<{ version: string }[]>`
    SELECT version
    FROM public.schema_migrations
    ORDER BY version
  `;
  return [
    {
      key: 'schema_migrations:versions',
      value: rows.map((row) => row.version).join(','),
    },
  ];
}

function diffSnapshots(fresh: Map<string, string>, migrated: Map<string, string>): Drift[] {
  const keys = [...new Set([...fresh.keys(), ...migrated.keys()])].sort();
  const drift: Drift[] = [];

  for (const key of keys) {
    const freshValue = fresh.get(key) ?? null;
    const migratedValue = migrated.get(key) ?? null;
    if (freshValue !== migratedValue) {
      drift.push({ fresh: freshValue, key, migrated: migratedValue });
    }
  }

  return drift;
}

function databaseUrlFor(databaseUrl: string, databaseName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function resolveRepoRoot(...paths: readonly string[]): string {
  return resolve(fileURLToPath(new URL('..', import.meta.url)), ...paths);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown): void => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
