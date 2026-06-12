import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  findMissingMigrationFiles,
  parseCliMode,
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
