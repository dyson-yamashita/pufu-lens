import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const migrationPath = join(
  import.meta.dirname,
  '../infra/db/migrations/0011_data_source_schedules.sql',
);
const initPath = join(import.meta.dirname, '../infra/docker/postgres/init.sql');
const defaultMigrationPath = join(
  import.meta.dirname,
  '../infra/db/migrations/0014_data_source_schedule_default_0600.sql',
);

test('0011 creates tenant-scoped daily schedules and backfills only enabled non-web sources', async () => {
  const migration = await readFile(migrationPath, 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.data_source_schedules/);
  assert.match(migration, /UNIQUE \(project_id, data_source_id\)/);
  assert.match(migration, /FOREIGN KEY \(data_source_id, project_id\)/);
  assert.match(migration, /source\.enabled = true/);
  assert.match(migration, /source\.source_type IN \('github', 'drive', 'gmail'\)/);
  assert.match(migration, /ON CONFLICT \(data_source_id\) DO NOTHING/);
  assert.match(migration, /timezone = 'Asia\/Tokyo'/);
});

test('0011 and fresh schema share schedule constraints and migration version', async () => {
  const [migration, init] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);
  for (const name of [
    'data_source_schedules_data_source_key',
    'data_source_schedules_project_data_source_key',
    'data_source_schedules_timezone_check',
    'data_source_schedules_lease_pair_check',
    'data_source_schedules_source_scope_fkey',
    'data_sources_id_project_key',
  ]) {
    assert.ok(migration.includes(name));
    assert.ok(init.includes(name));
  }
  assert.match(init, /'0011_data_source_schedules'/);
});

test('0014 changes only the daily_time column default for future rows', async () => {
  const migration = await readFile(defaultMigrationPath, 'utf8');

  assert.match(migration, /0014_data_source_schedule_default_0600/);
  assert.match(migration, /ALTER TABLE public\.data_source_schedules/);
  assert.match(migration, /ALTER COLUMN daily_time SET DEFAULT TIME '06:00'/);
  assert.doesNotMatch(migration, /UPDATE public\.data_source_schedules/i);
  assert.doesNotMatch(migration, /next_run_at/i);
});

test('0014 and fresh schema share migration version and distinct schedule defaults', async () => {
  const init = await readFile(initPath, 'utf8');

  assert.match(init, /'0014_data_source_schedule_default_0600'/);
  assert.match(
    init,
    /CREATE TABLE public\.data_source_schedules[\s\S]*?daily_time TIME NOT NULL DEFAULT TIME '06:00'/,
  );
  assert.match(
    init,
    /CREATE TABLE public\.project_report_schedules[\s\S]*?run_time TIME NOT NULL DEFAULT TIME '10:00'/,
  );
});
