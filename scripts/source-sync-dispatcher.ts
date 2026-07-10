import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  dispatchDueSourceSyncs,
  SourceSyncCommandError,
  type SourceSyncScheduleRepository,
  type SourceSyncTarget,
} from './lib/source-sync-dispatcher.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEASE_MINUTES = 15;
const MAX_LEASE_MINUTES = 60;

async function main(): Promise<void> {
  parseArgs(process.argv.slice(2));
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 2 });
  try {
    const result = await dispatchDueSourceSyncs({
      repository: createPostgresScheduleRepository(sql),
      runner: { run: runSourceSync },
    });
    console.log(JSON.stringify({ event: 'source_sync_dispatch_completed', ...result }));
    if (result.failed > 0 || result.leaseLost > 0) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

export function createPostgresScheduleRepository(sql: postgres.Sql): SourceSyncScheduleRepository {
  return {
    async claimDue({ limit, workerToken }) {
      return sql.begin(async (tx) => {
        const rows = (await tx`
          WITH due AS (
            SELECT schedule.id
            FROM public.data_source_schedules AS schedule
            JOIN public.data_sources AS source
              ON source.id = schedule.data_source_id
             AND source.project_id = schedule.project_id
            WHERE schedule.enabled = true
              AND source.enabled = true
              AND source.source_type IN ('drive', 'github', 'gmail')
              AND schedule.next_run_at <= now()
              AND (schedule.lease_expires_at IS NULL OR schedule.lease_expires_at <= now())
            ORDER BY schedule.next_run_at, schedule.id
            FOR UPDATE OF schedule SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE public.data_source_schedules AS schedule
          SET
            worker_token = ${workerToken},
            lease_expires_at = now() + ${LEASE_MINUTES} * interval '1 minute',
            last_started_at = now(),
            updated_at = now()
          FROM due, public.data_sources AS source, public.projects AS project
          WHERE schedule.id = due.id
            AND source.id = schedule.data_source_id
            AND source.project_id = schedule.project_id
            AND project.id = schedule.project_id
          RETURNING
            schedule.id::text AS "scheduleId",
            source.id::text AS "dataSourceId",
            source.source_type AS "sourceType",
            project.slug AS "projectSlug"
        `) as readonly unknown[];
        return rows.map(parseSourceSyncTarget);
      });
    },
    async heartbeat({ scheduleId, workerToken }) {
      const rows = (await sql`
        UPDATE public.data_source_schedules
        SET
          lease_expires_at = LEAST(
            now() + ${LEASE_MINUTES} * interval '1 minute',
            last_started_at + ${MAX_LEASE_MINUTES} * interval '1 minute'
          ),
          updated_at = now()
        WHERE id = ${scheduleId}
          AND worker_token = ${workerToken}
          AND lease_expires_at > now()
          AND last_started_at + ${MAX_LEASE_MINUTES} * interval '1 minute' > now()
        RETURNING id
      `) as readonly unknown[];
      return rows.length === 1;
    },
    async markSucceeded({ scheduleId, workerToken }) {
      const rows = (await sql`
        UPDATE public.data_source_schedules AS schedule
        SET
          next_run_at = (
            CASE
              WHEN (now() AT TIME ZONE schedule.timezone)::time < schedule.daily_time
                THEN (now() AT TIME ZONE schedule.timezone)::date
              ELSE (now() AT TIME ZONE schedule.timezone)::date + 1
            END + schedule.daily_time
          ) AT TIME ZONE schedule.timezone,
          lease_expires_at = NULL,
          worker_token = NULL,
          last_succeeded_at = now(),
          retry_count = 0,
          last_error = NULL,
          updated_at = now()
        WHERE schedule.id = ${scheduleId}
          AND schedule.worker_token = ${workerToken}
          AND schedule.lease_expires_at > now()
        RETURNING id
      `) as readonly unknown[];
      return rows.length === 1;
    },
    async markFailed({ error, scheduleId, workerToken }) {
      const rows = (await sql`
        UPDATE public.data_source_schedules AS schedule
        SET
          next_run_at = CASE schedule.retry_count
            WHEN 0 THEN now() + interval '15 minutes'
            WHEN 1 THEN now() + interval '1 hour'
            WHEN 2 THEN now() + interval '6 hours'
            ELSE (
              CASE
                WHEN (now() AT TIME ZONE schedule.timezone)::time < schedule.daily_time
                  THEN (now() AT TIME ZONE schedule.timezone)::date
                ELSE (now() AT TIME ZONE schedule.timezone)::date + 1
              END + schedule.daily_time
            ) AT TIME ZONE schedule.timezone
          END,
          lease_expires_at = NULL,
          worker_token = NULL,
          last_failed_at = now(),
          retry_count = CASE WHEN schedule.retry_count >= 3 THEN 0 ELSE schedule.retry_count + 1 END,
          last_error = left(${error}, 500),
          updated_at = now()
        WHERE schedule.id = ${scheduleId}
          AND schedule.worker_token = ${workerToken}
          AND schedule.lease_expires_at > now()
        RETURNING id
      `) as readonly unknown[];
      return rows.length === 1;
    },
  };
}

async function runSourceSync(target: SourceSyncTarget): Promise<void> {
  await runScript('collect', [
    join(repoRoot, 'scripts/collect-source.ts'),
    '--project',
    target.projectSlug,
    '--source',
    target.sourceType,
    '--data-source-id',
    target.dataSourceId,
  ]);
  await runScript('ingest', [
    join(repoRoot, 'scripts/ingest-workflow.ts'),
    'run',
    '--project',
    target.projectSlug,
    '--source',
    target.sourceType,
    '--data-source-id',
    target.dataSourceId,
    '--drain',
    '--max-runtime-seconds',
    '540',
  ]);
}

async function runScript(step: 'collect' | 'ingest', args: string[]): Promise<void> {
  const child = spawn(process.execPath, [...process.execArgv, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (exitCode !== 0) throw new SourceSyncCommandError(step, exitCode);
}

function parseSourceSyncTarget(value: unknown): SourceSyncTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid source sync target row.');
  }
  const scheduleId = requireRowString(Reflect.get(value, 'scheduleId'), 'scheduleId');
  const dataSourceId = requireRowString(Reflect.get(value, 'dataSourceId'), 'dataSourceId');
  const projectSlug = requireRowString(Reflect.get(value, 'projectSlug'), 'projectSlug');
  const sourceType = Reflect.get(value, 'sourceType');
  if (sourceType !== 'drive' && sourceType !== 'github' && sourceType !== 'gmail') {
    throw new Error('Invalid source sync target row field: sourceType');
  }
  return { dataSourceId, projectSlug, scheduleId, sourceType };
}

function requireRowString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value)
    throw new Error(`Invalid source sync target row field: ${field}`);
  return value;
}

function parseArgs(args: readonly string[]): void {
  if (args.length !== 1 || args[0] !== '--once') {
    throw new Error('source sync dispatcher requires --once.');
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'source sync dispatcher failed');
    process.exitCode = 1;
  });
}
