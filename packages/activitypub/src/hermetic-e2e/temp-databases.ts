import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const TEMP_DB_PREFIX = 'pufu_ap_e2e_';
const TEMP_DB_NAME_PATTERN = /^pufu_ap_e2e_[a-z0-9_]+$/;
const INIT_SQL_PATH = resolve(
  fileURLToPath(new URL('../../../../infra/docker/postgres/init.sql', import.meta.url)),
);

export type HermeticTempDatabase = {
  readonly name: string;
  readonly url: string;
};

export type HermeticTempDatabasePair = {
  readonly adminSql: postgres.Sql;
  readonly lensA: HermeticTempDatabase;
  readonly lensB: HermeticTempDatabase;
};

/** Creates two isolated PostgreSQL databases for hermetic ActivityPub E2E tests. */
export async function createHermeticTempDatabasePair(
  databaseUrl: string,
): Promise<HermeticTempDatabasePair> {
  const suffix = `${process.pid}_${Date.now().toString(36)}`;
  const lensAName = `${TEMP_DB_PREFIX}a_${suffix}`;
  const lensBName = `${TEMP_DB_PREFIX}b_${suffix}`;
  assertSafeTempDatabaseName(lensAName);
  assertSafeTempDatabaseName(lensBName);

  const adminSql = postgres(databaseUrlFor(databaseUrl, 'postgres'), { max: 1 });
  const createdDatabaseNames: string[] = [];
  try {
    await createDatabase(adminSql, lensAName);
    createdDatabaseNames.push(lensAName);
    await createDatabase(adminSql, lensBName);
    createdDatabaseNames.push(lensBName);

    const lensAUrl = databaseUrlFor(databaseUrl, lensAName);
    const lensBUrl = databaseUrlFor(databaseUrl, lensBName);
    await applyInitSql(lensAUrl, lensAName);
    await applyInitSql(lensBUrl, lensBName);

    return {
      adminSql,
      lensA: { name: lensAName, url: lensAUrl },
      lensB: { name: lensBName, url: lensBUrl },
    };
  } catch (error) {
    for (const databaseName of createdDatabaseNames.reverse()) {
      await dropDatabase(adminSql, databaseName).catch(() => undefined);
    }
    await adminSql.end({ timeout: 5 }).catch(() => undefined);
    throw error;
  }
}

/** Drops hermetic temp databases after validating their names. */
export async function dropHermeticTempDatabases(
  adminSql: postgres.Sql,
  databaseNames: readonly string[],
): Promise<void> {
  for (const databaseName of databaseNames) {
    assertSafeTempDatabaseName(databaseName);
    await dropDatabase(adminSql, databaseName);
  }
}

export function assertSafeTempDatabaseName(databaseName: string): void {
  if (!TEMP_DB_NAME_PATTERN.test(databaseName)) {
    throw new Error(`Refusing to operate on unsafe temp database name: ${databaseName}`);
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

async function applyInitSql(databaseUrl: string, databaseName: string): Promise<void> {
  const sqlText = await readFile(INIT_SQL_PATH, 'utf8');
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe(rewriteDatabaseName(sqlText, databaseName));
    await sql.unsafe(
      `ALTER DATABASE ${quoteIdentifier(databaseName)} SET search_path = public, ag_catalog, "$user"`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function rewriteDatabaseName(sqlText: string, databaseName: string): string {
  return sqlText.replace(
    /ALTER\s+DATABASE\s+pufu_lens\s+SET\s+search_path/gi,
    `ALTER DATABASE ${quoteIdentifier(databaseName)} SET search_path`,
  );
}

function databaseUrlFor(databaseUrl: string, databaseName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
