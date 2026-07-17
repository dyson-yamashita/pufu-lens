import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  createExtractiveReportProvider,
  createGeminiReportProvider,
  createPostgresReportRepository,
  createReportStorageFromEnv,
  type ReportGenerationKind,
  type ReportRepository,
  runGenerateReport,
} from '../apps/web/src/report.ts';
import { readPreviousScheduledReport as readPreviousScheduledReportFromSql } from '../apps/web/src/report-schedule-planning.ts';
import {
  isReportScheduleRunKind,
  isScheduledReportFrequency,
} from '../apps/web/src/report-schedules.ts';
import {
  dispatchReportSchedules,
  type ReportScheduleDispatcherRepository,
  ReportScheduleGenerationError,
  type ReportScheduleRunOutcome,
  type ReportScheduleRunTarget,
} from './lib/report-schedule-dispatcher.ts';
import {
  type DueMaterializeScheduleRow,
  enumerateDueMaterializePeriods,
  parseDueMaterializeScheduleRow,
} from './lib/report-schedule-materialize.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEASE_MINUTES = 15;
const MAX_LEASE_MINUTES = 60;
const MATERIALIZE_PERIOD_LIMIT = 10;

async function main(): Promise<void> {
  parseArgs(process.argv.slice(2));
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 2 });
  const storage = createReportStorageFromEnv();
  const reportRepository = createPostgresReportRepository(sql);
  const provider =
    process.env.GEMINI_API_KEY && process.env.GEMINI_CHAT_MODEL
      ? createGeminiReportProvider({
          apiKey: process.env.GEMINI_API_KEY,
          model: process.env.GEMINI_CHAT_MODEL,
        })
      : createExtractiveReportProvider();
  try {
    const result = await dispatchReportSchedules({
      repository: createPostgresReportScheduleDispatcherRepository(sql),
      runner: {
        run: (target, signal) =>
          runScheduledReport({
            provider,
            reportRepository,
            signal,
            sql,
            storage,
            target,
          }),
      },
    });
    console.log(JSON.stringify({ event: 'report_schedule_dispatch_completed', ...result }));
    if (result.failed > 0 || result.leaseLost > 0) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

export function createPostgresReportScheduleDispatcherRepository(
  sql: postgres.Sql,
): ReportScheduleDispatcherRepository {
  return {
    async materializeDue({ limit }) {
      let materialized = 0;
      while (materialized < limit) {
        const schedule = await claimDueScheduleForMaterialize(sql);
        if (!schedule) break;
        const enumeration = enumerateDueMaterializePeriods({
          asOf: schedule.claimedAt,
          frequency: schedule.frequency,
          limit: Math.min(MATERIALIZE_PERIOD_LIMIT, limit - materialized),
          nextRunAt: schedule.nextRunAt,
        });
        for (const period of enumeration.periods) {
          await sql`
            INSERT INTO public.report_schedule_period_runs (
              schedule_id,
              project_id,
              frequency,
              period_start,
              period_end,
              run_kind,
              status
            )
            VALUES (
              ${schedule.scheduleId},
              ${schedule.projectId},
              ${schedule.frequency},
              ${period.start}::date,
              ${period.end}::date,
              'scheduled',
              'pending'
            )
            ON CONFLICT (project_id, frequency, period_start, period_end) DO NOTHING
          `;
          materialized += 1;
          if (materialized >= limit) break;
        }
        const released = await releaseMaterializedScheduleLease(sql, {
          nextRunAt: enumeration.nextRunAt,
          projectId: schedule.projectId,
          scheduleId: schedule.scheduleId,
          workerToken: schedule.workerToken,
        });
        if (!released) {
          throw new MaterializeScheduleLeaseLostError(schedule.scheduleId);
        }
        if (enumeration.hasMore && materialized >= limit) break;
      }
      return materialized;
    },
    async claimRunnable({ limit, workerToken }) {
      return sql.begin(async (tx) => {
        const rows = (await tx`
          WITH candidates AS (
            SELECT period_run.id
            FROM public.report_schedule_period_runs AS period_run
            JOIN public.project_report_schedules AS schedule
              ON schedule.id = period_run.schedule_id
             AND schedule.project_id = period_run.project_id
            JOIN public.projects AS project
              ON project.id = period_run.project_id
            WHERE schedule.frequency <> 'none'
              AND (
                (
                  period_run.status = 'pending'
                  AND (
                    period_run.lease_expires_at IS NULL
                    OR period_run.lease_expires_at <= now()
                  )
                )
                OR (
                  period_run.status = 'retry_wait'
                  AND period_run.next_attempt_at <= now()
                  AND (
                    period_run.lease_expires_at IS NULL
                    OR period_run.lease_expires_at <= now()
                  )
                )
                OR (
                  period_run.status = 'running'
                  AND period_run.lease_expires_at <= now()
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM public.report_schedule_period_runs AS older
                WHERE older.project_id = period_run.project_id
                  AND older.schedule_id = period_run.schedule_id
                  AND older.frequency = period_run.frequency
                  AND older.status NOT IN ('succeeded', 'skipped')
                  AND (
                    older.period_start,
                    older.period_end,
                    older.id
                  ) < (
                    period_run.period_start,
                    period_run.period_end,
                    period_run.id
                  )
              )
            ORDER BY period_run.period_start, period_run.period_end, period_run.id
            FOR UPDATE OF period_run SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE public.report_schedule_period_runs AS period_run
          SET
            status = 'running',
            worker_token = ${workerToken},
            lease_expires_at = now() + ${LEASE_MINUTES} * interval '1 minute',
            started_at = COALESCE(period_run.started_at, now()),
            updated_at = now()
          FROM candidates, public.project_report_schedules AS schedule, public.projects AS project
          WHERE period_run.id = candidates.id
            AND schedule.id = period_run.schedule_id
            AND schedule.project_id = period_run.project_id
            AND project.id = period_run.project_id
          RETURNING
            period_run.id::text AS "periodRunId",
            period_run.schedule_id::text AS "scheduleId",
            period_run.project_id::text AS "projectId",
            project.slug AS "projectSlug",
            period_run.frequency,
            period_run.period_start::text AS "periodStart",
            period_run.period_end::text AS "periodEnd",
            period_run.run_kind AS "runKind"
        `) as readonly unknown[];
        return rows.map(parseReportScheduleRunTarget);
      });
    },
    async heartbeat({ periodRunId, workerToken }) {
      const rows = (await sql`
        UPDATE public.report_schedule_period_runs
        SET
          lease_expires_at = LEAST(
            now() + ${LEASE_MINUTES} * interval '1 minute',
            started_at + ${MAX_LEASE_MINUTES} * interval '1 minute'
          ),
          updated_at = now()
        WHERE id = ${periodRunId}
          AND worker_token = ${workerToken}
          AND lease_expires_at > now()
          AND started_at + ${MAX_LEASE_MINUTES} * interval '1 minute' > now()
        RETURNING id
      `) as readonly unknown[];
      return rows.length === 1;
    },
    async markSucceeded({ periodRunId, reportId, workerToken }) {
      return sql.begin(async (tx) => {
        const rows = (await tx`
          UPDATE public.report_schedule_period_runs AS period_run
          SET
            status = 'succeeded',
            report_id = ${reportId},
            completed_at = now(),
            lease_expires_at = NULL,
            worker_token = NULL,
            last_error = NULL,
            updated_at = now()
          WHERE period_run.id = ${periodRunId}
            AND period_run.worker_token = ${workerToken}
            AND period_run.lease_expires_at > now()
          RETURNING period_run.schedule_id::text AS "scheduleId", period_run.project_id::text AS "projectId"
        `) as readonly unknown[];
        const completion = parsePeriodRunScheduleScopeRow(rows[0]);
        if (!completion) return false;
        await updateScheduleSummaryOnSuccess(tx, completion);
        return true;
      });
    },
    async markSkipped({ periodRunId, skipReason, workerToken }) {
      return sql.begin(async (tx) => {
        const rows = (await tx`
          UPDATE public.report_schedule_period_runs AS period_run
          SET
            status = 'skipped',
            skip_reason = left(${skipReason}, 1000),
            completed_at = now(),
            lease_expires_at = NULL,
            worker_token = NULL,
            last_error = NULL,
            updated_at = now()
          WHERE period_run.id = ${periodRunId}
            AND period_run.worker_token = ${workerToken}
            AND period_run.lease_expires_at > now()
          RETURNING period_run.schedule_id::text AS "scheduleId", period_run.project_id::text AS "projectId"
        `) as readonly unknown[];
        const completion = parsePeriodRunScheduleScopeRow(rows[0]);
        if (!completion) return false;
        await updateScheduleSummaryOnSuccess(tx, completion);
        return true;
      });
    },
    async markFailed({ error, periodRunId, workerToken }) {
      return sql.begin(async (tx) => {
        const rows = (await tx`
          UPDATE public.report_schedule_period_runs AS period_run
          SET
            status = CASE
              WHEN period_run.attempt_count >= 3 THEN 'retry_exhausted'
              ELSE 'retry_wait'
            END,
            attempt_count = period_run.attempt_count + 1,
            next_attempt_at = CASE period_run.attempt_count
              WHEN 0 THEN now() + interval '15 minutes'
              WHEN 1 THEN now() + interval '1 hour'
              WHEN 2 THEN now() + interval '6 hours'
              ELSE NULL
            END,
            lease_expires_at = NULL,
            worker_token = NULL,
            last_error = left(${error}, 1000),
            updated_at = now()
          WHERE period_run.id = ${periodRunId}
            AND period_run.worker_token = ${workerToken}
            AND period_run.lease_expires_at > now()
          RETURNING
            period_run.schedule_id::text AS "scheduleId",
            period_run.project_id::text AS "projectId",
            period_run.attempt_count AS "attemptCount",
            period_run.status AS status
        `) as readonly unknown[];
        const completion = parsePeriodRunFailureRow(rows[0]);
        if (!completion) return false;
        await updateScheduleSummaryOnFailure(tx, {
          attemptCount: completion.attemptCount,
          projectId: completion.projectId,
          safeError: error,
          scheduleId: completion.scheduleId,
        });
        return true;
      });
    },
  };
}

async function claimDueScheduleForMaterialize(
  sql: postgres.Sql,
): Promise<DueMaterializeScheduleRow | null> {
  const rows = (await sql.begin(async (tx) => {
    return tx`
      WITH due AS (
        SELECT schedule.id
        FROM public.project_report_schedules AS schedule
        WHERE schedule.frequency <> 'none'
          AND schedule.next_run_at <= now()
          AND (
            schedule.lease_expires_at IS NULL
            OR schedule.lease_expires_at <= now()
          )
        ORDER BY schedule.next_run_at, schedule.id
        FOR UPDATE OF schedule SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.project_report_schedules AS schedule
      SET
        worker_token = gen_random_uuid()::text,
        lease_expires_at = now() + ${LEASE_MINUTES} * interval '1 minute',
        last_started_at = now(),
        updated_at = now()
      FROM due
      WHERE schedule.id = due.id
      RETURNING
        schedule.id::text AS "scheduleId",
        schedule.project_id::text AS "projectId",
        schedule.frequency,
        schedule.next_run_at AS "nextRunAt",
        schedule.worker_token AS "workerToken",
        now() AS "claimedAt"
    `;
  })) as readonly unknown[];
  return parseDueMaterializeScheduleRow(rows[0]);
}

async function releaseMaterializedScheduleLease(
  sql: postgres.Sql,
  input: {
    readonly nextRunAt: string;
    readonly projectId: string;
    readonly scheduleId: string;
    readonly workerToken: string;
  },
): Promise<boolean> {
  const rows = (await sql`
    UPDATE public.project_report_schedules AS schedule
    SET
      next_run_at = ${input.nextRunAt},
      lease_expires_at = NULL,
      worker_token = NULL,
      updated_at = now()
    WHERE schedule.id = ${input.scheduleId}
      AND schedule.project_id = ${input.projectId}
      AND schedule.worker_token = ${input.workerToken}
      AND schedule.lease_expires_at > now()
    RETURNING schedule.id
  `) as readonly unknown[];
  return rows.length === 1;
}

interface PeriodRunScheduleScopeRow {
  readonly projectId: string;
  readonly scheduleId: string;
}

interface PeriodRunFailureRow extends PeriodRunScheduleScopeRow {
  readonly attemptCount: number;
  readonly status: string;
}

async function updateScheduleSummaryOnSuccess(
  tx: postgres.TransactionSql,
  input: PeriodRunScheduleScopeRow,
): Promise<void> {
  await tx`
    UPDATE public.project_report_schedules AS schedule
    SET
      last_succeeded_at = now(),
      retry_count = 0,
      last_error = NULL,
      updated_at = now()
    WHERE schedule.id = ${input.scheduleId}
      AND schedule.project_id = ${input.projectId}
  `;
}

async function updateScheduleSummaryOnFailure(
  tx: postgres.TransactionSql,
  input: {
    readonly attemptCount: number;
    readonly projectId: string;
    readonly safeError: string;
    readonly scheduleId: string;
  },
): Promise<void> {
  await tx`
    UPDATE public.project_report_schedules AS schedule
    SET
      last_failed_at = now(),
      retry_count = ${input.attemptCount},
      last_error = left(${input.safeError}, 1000),
      updated_at = now()
    WHERE schedule.id = ${input.scheduleId}
      AND schedule.project_id = ${input.projectId}
  `;
}

function parsePeriodRunScheduleScopeRow(value: unknown): PeriodRunScheduleScopeRow | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid period run schedule scope row.');
  }
  return {
    projectId: requireRowString(value.projectId, 'projectId'),
    scheduleId: requireRowString(value.scheduleId, 'scheduleId'),
  };
}

function parsePeriodRunFailureRow(value: unknown): PeriodRunFailureRow | null {
  const scope = parsePeriodRunScheduleScopeRow(value);
  if (!scope || !isRecord(value)) {
    return null;
  }
  const attemptCount = value.attemptCount;
  const status = value.status;
  if (typeof attemptCount !== 'number' || !Number.isInteger(attemptCount) || attemptCount < 0) {
    throw new Error('Invalid period run failure row field: attemptCount');
  }
  if (typeof status !== 'string' || status.length === 0) {
    throw new Error('Invalid period run failure row field: status');
  }
  return { ...scope, attemptCount, status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class MaterializeScheduleLeaseLostError extends Error {
  constructor(scheduleId: string) {
    super(`materialize schedule lease lost for ${scheduleId}`);
    this.name = 'MaterializeScheduleLeaseLostError';
  }
}

async function runScheduledReport(input: {
  readonly provider: Parameters<typeof runGenerateReport>[0]['options']['provider'];
  readonly reportRepository: ReportRepository;
  readonly signal: AbortSignal;
  readonly sql: postgres.Sql;
  readonly storage: ReturnType<typeof createReportStorageFromEnv>;
  readonly target: ReportScheduleRunTarget;
}): Promise<ReportScheduleRunOutcome> {
  throwIfAborted(input.signal);
  const documents = await input.reportRepository.listRecentDocuments({
    limit: 1,
    period: { end: input.target.periodEnd, start: input.target.periodStart },
    projectId: input.target.projectId,
  });
  if (documents.length === 0) {
    return { skipReason: 'no_documents', type: 'skipped' };
  }
  const previous = await readPreviousScheduledReportFromSql(input.sql, {
    beforePeriodStart: input.target.periodStart,
    frequency: input.target.frequency,
    projectId: input.target.projectId,
  });
  throwIfAborted(input.signal);
  const generationKind: ReportGenerationKind =
    input.target.runKind === 'scheduled_backfill' ? 'scheduled_backfill' : 'scheduled';
  const result = await runGenerateReport({
    options: {
      generatedBy: 'report-schedule-dispatcher',
      generationKind,
      period: { end: input.target.periodEnd, start: input.target.periodStart },
      previousScheduledReportId: previous?.id,
      provider: input.provider,
      repository: input.reportRepository,
      scheduleFrequency: input.target.frequency,
      schedulePeriodRunId: input.target.periodRunId,
      storage: input.storage,
    },
    projectSlug: input.target.projectSlug,
  });
  throwIfAborted(input.signal);
  return { reportId: result.report.report_id, type: 'report' };
}

function parseReportScheduleRunTarget(value: unknown): ReportScheduleRunTarget {
  if (!isRecord(value)) {
    throw new Error('Invalid report schedule run target row.');
  }
  const frequency = value.frequency;
  const runKind = value.runKind;
  if (!isScheduledReportFrequency(frequency)) {
    throw new Error('Invalid report schedule run target field: frequency');
  }
  if (!isReportScheduleRunKind(runKind)) {
    throw new Error('Invalid report schedule run target field: runKind');
  }
  return {
    frequency,
    periodEnd: requireRowString(value.periodEnd, 'periodEnd'),
    periodRunId: requireRowString(value.periodRunId, 'periodRunId'),
    periodStart: requireRowString(value.periodStart, 'periodStart'),
    projectId: requireRowString(value.projectId, 'projectId'),
    projectSlug: requireRowString(value.projectSlug, 'projectSlug'),
    runKind,
    scheduleId: requireRowString(value.scheduleId, 'scheduleId'),
  };
}

function requireRowString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid report schedule row field: ${field}`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ReportScheduleGenerationError('aborted');
  }
}

function parseArgs(args: readonly string[]): void {
  if (args.length !== 1 || args[0] !== '--once') {
    throw new Error('report schedule dispatcher requires --once.');
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'report schedule dispatcher failed');
    process.exitCode = 1;
  });
}

export { repoRoot };
