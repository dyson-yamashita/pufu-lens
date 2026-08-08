import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyLoadedMigration,
  executeNonTransactionalMigrationStatements,
  findMissingMigrationFiles,
  MIGRATION_NO_TRANSACTION_DIRECTIVE,
  MIGRATION_STATEMENT_BREAK_DIRECTIVE,
  MigrationStatementParseError,
  parseCliMode,
  parseMigrationFileContent,
  parseMigrationFilename,
  partitionMigrations,
  validateMigrationFilenames,
  validateMigrationsDirectory,
} from './db-migrate.ts';

test('parseMigrationFilename accepts valid migration filenames', () => {
  assert.deepEqual(parseMigrationFilename('0001_auth_login.sql'), {
    prefix: '0001',
    version: '0001_auth_login',
  });
});

test('parseMigrationFilename rejects invalid migration filenames', () => {
  assert.equal(parseMigrationFilename('auth_login.sql'), null);
  assert.equal(parseMigrationFilename('0001.sql'), null);
  assert.equal(parseMigrationFilename('00001_auth_login.sql'), null);
});

test('validateMigrationFilenames reports empty directories', () => {
  const issues = validateMigrationFilenames([]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, 'empty_directory');
});

test('validateMigrationFilenames reports invalid filenames', () => {
  const issues = validateMigrationFilenames(['README.md', '0001_auth_login.sql']);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['invalid_filename'],
  );
});

test('validateMigrationFilenames reports duplicate numeric prefixes', () => {
  const issues = validateMigrationFilenames(['0002_a.sql', '0002_b.sql']);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['duplicate_prefix'],
  );
});

test('validateMigrationFilenames reports duplicate versions', () => {
  const issues = validateMigrationFilenames(['0001_same.sql', '0001_same.sql']);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['duplicate_version', 'duplicate_prefix'],
  );
});

test('validateMigrationFilenames passes for valid migration sets', () => {
  const issues = validateMigrationFilenames([
    '0001_auth_login.sql',
    '0002_project_oauth_connections.sql',
  ]);
  assert.deepEqual(issues, []);
});

test('validateMigrationsDirectory validates files on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-migrate-test-'));
  await writeFile(join(dir, '0001_valid.sql'), 'SELECT 1;');
  await writeFile(join(dir, '0002_valid.sql'), 'SELECT 2;');

  const issues = await validateMigrationsDirectory(dir);
  assert.deepEqual(issues, []);
});

test('validateMigrationsDirectory ignores hidden files on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-migrate-test-'));
  await writeFile(join(dir, '.DS_Store'), '');
  await writeFile(join(dir, '0001_valid.sql'), 'SELECT 1;');

  const issues = await validateMigrationsDirectory(dir);
  assert.deepEqual(issues, []);
});

test('partitionMigrations splits applied and pending versions', () => {
  const result = partitionMigrations(
    [{ version: '0001_auth_login' }, { version: '0002_project_oauth_connections' }],
    ['0001_auth_login'],
  );

  assert.deepEqual(result, {
    applied: ['0001_auth_login'],
    pending: ['0002_project_oauth_connections'],
  });
});

test('findMissingMigrationFiles detects applied versions without files', () => {
  const missing = findMissingMigrationFiles(
    ['0001_auth_login'],
    ['0001_auth_login', '0009_removed.sql'],
  );

  assert.deepEqual(missing, ['0009_removed.sql']);
});

test('parseCliMode maps supported flags and rejects ambiguous or unknown options', () => {
  assert.equal(parseCliMode([]), 'migrate');
  assert.equal(parseCliMode(['--plan']), 'plan');
  assert.equal(parseCliMode(['--list']), 'list');
  assert.equal(parseCliMode(['--check']), 'check');
  assert.throws(() => parseCliMode(['--plan', '--list']), /conflicting CLI modes/);
  assert.throws(() => parseCliMode(['--dry-run']), /unknown CLI option or argument/);
  assert.throws(() => parseCliMode(['plan']), /unknown CLI option or argument/);
});

test('parseMigrationFileContent defaults to transactional mode', () => {
  const parsed = parseMigrationFileContent('-- comment\nSELECT 1;');
  assert.equal(parsed.transactionMode, 'transactional');
  assert.match(parsed.sql, /SELECT 1;/);
});

test('parseMigrationFileContent parses exact no-transaction directive on first nonblank line', () => {
  const parsed = parseMigrationFileContent(
    `${MIGRATION_NO_TRANSACTION_DIRECTIVE}\nCREATE INDEX CONCURRENTLY foo ON bar;`,
  );
  assert.equal(parsed.transactionMode, 'non-transactional');
  assert.match(parsed.sql, /CREATE INDEX CONCURRENTLY foo ON bar;/);
  assert.equal(parsed.sql.includes(MIGRATION_NO_TRANSACTION_DIRECTIVE), false);
});

test('parseMigrationFileContent treats near-miss directive as transactional default', () => {
  const parsed = parseMigrationFileContent('-- pufu-lens: no-transaction extra\nSELECT 2;');
  assert.equal(parsed.transactionMode, 'transactional');
  assert.match(parsed.sql, /no-transaction extra/);
});

test('parseMigrationFileContent splits no-transaction SQL on exact statement-break lines', () => {
  const parsed = parseMigrationFileContent(
    `${MIGRATION_NO_TRANSACTION_DIRECTIVE}\nDROP INDEX a;\n${MIGRATION_STATEMENT_BREAK_DIRECTIVE}\nCREATE INDEX b ON c;`,
  );
  assert.equal(parsed.transactionMode, 'non-transactional');
  assert.deepEqual(parsed.statements, ['DROP INDEX a;', 'CREATE INDEX b ON c;']);
});

test('parseMigrationFileContent rejects empty statement chunks in no-transaction migrations', () => {
  assert.throws(
    () =>
      parseMigrationFileContent(
        `${MIGRATION_NO_TRANSACTION_DIRECTIVE}\nDROP INDEX a;\n${MIGRATION_STATEMENT_BREAK_DIRECTIVE}\n${MIGRATION_STATEMENT_BREAK_DIRECTIVE}\nCREATE INDEX b ON c;`,
      ),
    /empty migration statement chunk/,
  );
});

test('parseMigrationFileContent allows trailing statement-break and blank lines after final delimiter', () => {
  const parsed = parseMigrationFileContent(
    `${MIGRATION_NO_TRANSACTION_DIRECTIVE}\nDROP INDEX a;\n${MIGRATION_STATEMENT_BREAK_DIRECTIVE}\nCREATE INDEX b ON c;\n${MIGRATION_STATEMENT_BREAK_DIRECTIVE}\n\n\n`,
  );
  assert.deepEqual(parsed.statements, ['DROP INDEX a;', 'CREATE INDEX b ON c;']);
});

test('parseMigrationFileContent still rejects empty chunks between delimiters', () => {
  assert.throws(
    () =>
      parseMigrationFileContent(
        `${MIGRATION_NO_TRANSACTION_DIRECTIVE}\nDROP INDEX a;\n${MIGRATION_STATEMENT_BREAK_DIRECTIVE}\n\n${MIGRATION_STATEMENT_BREAK_DIRECTIVE}\nCREATE INDEX b ON c;`,
      ),
    /empty migration statement chunk/,
  );
});

test('validateMigrationsDirectory parses valid migration files without DATABASE_URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-migrate-parse-test-'));
  await writeFile(join(dir, '0001_valid.sql'), 'SELECT 1;');
  await writeFile(
    join(dir, '0002_no_transaction.sql'),
    `${MIGRATION_NO_TRANSACTION_DIRECTIVE}\nSELECT 2;`,
  );

  const issues = await validateMigrationsDirectory(dir);
  assert.deepEqual(issues, []);
});

test('validateMigrationsDirectory rejects broken no-transaction migration content without DATABASE_URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-migrate-parse-broken-'));
  await writeFile(
    join(dir, '0001_broken.sql'),
    `${MIGRATION_NO_TRANSACTION_DIRECTIVE}\nDROP INDEX a;\n${MIGRATION_STATEMENT_BREAK_DIRECTIVE}\n${MIGRATION_STATEMENT_BREAK_DIRECTIVE}\nCREATE INDEX b ON c;`,
  );

  await assert.rejects(
    () => validateMigrationsDirectory(dir),
    (error: unknown) => error instanceof MigrationStatementParseError,
  );
});

test('parseMigrationFileContent does not split near-miss statement-break delimiter lines', () => {
  const parsed = parseMigrationFileContent(
    `${MIGRATION_NO_TRANSACTION_DIRECTIVE}\n-- pufu-lens: statement-break extra\nSELECT 1;`,
  );
  assert.equal(parsed.statements.length, 1);
  assert.match(parsed.statements[0] ?? '', /statement-break extra/);
});

test('executeNonTransactionalMigrationStatements runs each chunk via separate unsafe calls', async () => {
  const unsafeCalls: string[] = [];
  const fakeSql = {
    async unsafe(statement: string) {
      unsafeCalls.push(statement);
    },
  } as never;

  await executeNonTransactionalMigrationStatements(fakeSql, [
    'DROP INDEX a;',
    'CREATE INDEX b ON c;',
  ]);

  assert.deepEqual(unsafeCalls, ['DROP INDEX a;', 'CREATE INDEX b ON c;']);
});

test('applyLoadedMigration records version only after all non-transaction statements succeed', async () => {
  const unsafeCalls: string[] = [];
  let versionRecorded = false;
  const fakeSql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = String.raw({ raw: strings }, ...values);
      if (query.includes('INSERT INTO public.schema_migrations')) {
        versionRecorded = true;
      }
      return [];
    },
    {
      unsafe: async (statement: string) => {
        unsafeCalls.push(statement);
        if (statement.includes('FAIL')) {
          throw new Error('statement failed');
        }
      },
    },
  ) as never;

  await applyLoadedMigration(fakeSql, {
    version: '0018_activitypub_follow_indexes',
    transactionMode: 'non-transactional',
    sql: '',
    statements: ['DROP INDEX a;', 'CREATE INDEX b ON c;'],
  });
  assert.deepEqual(unsafeCalls, ['DROP INDEX a;', 'CREATE INDEX b ON c;']);
  assert.equal(versionRecorded, true);

  versionRecorded = false;
  unsafeCalls.length = 0;
  await assert.rejects(
    () =>
      applyLoadedMigration(fakeSql, {
        version: '0018_activitypub_follow_indexes',
        transactionMode: 'non-transactional',
        sql: '',
        statements: ['DROP INDEX a;', 'CREATE INDEX FAIL b ON c;'],
      }),
    /statement failed/,
  );
  assert.deepEqual(unsafeCalls, ['DROP INDEX a;', 'CREATE INDEX FAIL b ON c;']);
  assert.equal(versionRecorded, false);
});
