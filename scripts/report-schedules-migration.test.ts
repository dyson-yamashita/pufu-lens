import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const migrationPath = join(
  import.meta.dirname,
  '../infra/db/migrations/0012_periodic_report_schedules.sql',
);
const backfillMigrationPath = join(
  import.meta.dirname,
  '../infra/db/migrations/0013_consolidate_initial_report_backfill.sql',
);
const initPath = join(import.meta.dirname, '../infra/docker/postgres/init.sql');

test('0012 creates tenant-scoped report schedules and period-run history', async () => {
  const migration = await readFile(migrationPath, 'utf8');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.project_report_schedules/);
  assert.match(migration, /UNIQUE \(project_id\)/);
  assert.match(migration, /frequency IN \('none', 'weekly', 'monthly', 'annually'\)/);
  assert.match(migration, /frequency = 'none' AND next_run_at IS NULL/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.report_schedule_period_runs/);
  assert.match(migration, /UNIQUE \(project_id, frequency, period_start, period_end\)/);
  assert.match(migration, /FOREIGN KEY \(schedule_id, project_id\)/);
  assert.match(migration, /status <> 'skipped'/);
  assert.match(migration, /report_id IS NULL AND skip_reason IS NOT NULL/);
  assert.match(migration, /report_schedule_period_runs_succeeded_check/);
  assert.match(migration, /status = 'succeeded' AND report_id IS NOT NULL/);
});

test('0012 constrains scheduled report metadata to one tenant-scoped period run', async () => {
  const migration = await readFile(migrationPath, 'utf8');

  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS generation_kind TEXT NOT NULL DEFAULT 'manual'/,
  );
  assert.match(migration, /reports_schedule_metadata_check/);
  assert.match(migration, /reports_schedule_period_run_key UNIQUE \(schedule_period_run_id\)/);
  assert.match(migration, /FOREIGN KEY \(schedule_period_run_id, project_id, schedule_frequency\)/);
  assert.match(
    migration,
    /FOREIGN KEY \(project_id, schedule_frequency, previous_scheduled_report_id\)/,
  );
  assert.match(migration, /FOREIGN KEY \(report_id, id, project_id, frequency\)/);
  assert.match(
    migration,
    /REFERENCES public\.reports\(id, schedule_period_run_id, project_id, schedule_frequency\)/,
  );
});

test('0012 and fresh schema share periodic report constraints and migration version', async () => {
  const [migration, init] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(initPath, 'utf8'),
  ]);

  for (const name of [
    'project_report_schedules_project_key',
    'project_report_schedules_id_project_key',
    'project_report_schedules_frequency_check',
    'project_report_schedules_next_run_check',
    'project_report_schedules_lease_pair_check',
    'report_schedule_period_runs_project_period_key',
    'report_schedule_period_runs_id_project_frequency_key',
    'report_schedule_period_runs_schedule_scope_fkey',
    'report_schedule_period_runs_skipped_check',
    'report_schedule_period_runs_succeeded_check',
    'report_schedule_period_runs_report_scope_fkey',
    'reports_generation_kind_check',
    'reports_schedule_metadata_check',
    'reports_project_schedule_frequency_id_key',
    'reports_previous_scheduled_scope_fkey',
    'reports_schedule_period_run_scope_fkey',
    'reports_schedule_period_run_key',
  ]) {
    assert.ok(migration.includes(name), `${name} is missing from migration`);
    assert.ok(init.includes(name), `${name} is missing from fresh schema`);
  }
  assert.match(init, /'0012_periodic_report_schedules'/);
});

test('0013 consolidates only untouched multi-row scheduled_backfill groups', async () => {
  const migration = await readFile(backfillMigrationPath, 'utf8');

  assert.match(migration, /0013_consolidate_initial_report_backfill/);
  assert.match(
    migration,
    /LOCK TABLE public\.report_schedule_period_runs IN SHARE ROW EXCLUSIVE MODE/,
  );
  assert.match(migration, /run_kind = 'scheduled_backfill'/);
  assert.match(migration, /HAVING count\(\*\) > 1/);
  assert.match(migration, /period_run\.status = 'pending'/);
  assert.match(migration, /period_run\.attempt_count = 0/);
  assert.match(migration, /period_run\.next_attempt_at IS NULL/);
  assert.match(migration, /period_run\.worker_token IS NULL/);
  assert.match(migration, /period_run\.report_id IS NULL/);
  assert.match(migration, /min\(period_run\.period_start\)/);
  assert.match(migration, /max\(period_run\.period_end\)/);
  assert.match(migration, /DELETE FROM public\.report_schedule_period_runs/);
  assert.match(migration, /INSERT INTO public\.report_schedule_period_runs/);
  assert.doesNotMatch(migration, /^\s*BEGIN\s*;/m);
  assert.doesNotMatch(migration, /^\s*COMMIT\s*;/m);
});

test('0013 and fresh schema share migration version seed without schema drift', async () => {
  const init = await readFile(initPath, 'utf8');

  assert.match(init, /'0013_consolidate_initial_report_backfill'/);
});
