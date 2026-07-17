import type postgres from 'postgres';
import {
  enumerateBackfillScheduledReportPeriods,
  MAX_REPORT_PERIOD_ENUMERATION,
  resolveNextScheduledReportRunAt,
  shouldEnqueueInitialReportBackfill,
} from './report-schedule-periods.ts';
import {
  hasScheduledReportForFrequency,
  readProjectReportAvailableFrom,
} from './report-schedule-planning.ts';
import {
  isReportScheduleFrequency,
  isScheduledReportFrequency,
  listReportSchedulePeriodRuns,
  type ProjectReportSchedule,
  parseProjectReportScheduleRow,
  REPORT_SCHEDULE_TIMEZONE,
  type ReportScheduleFrequency,
  type ReportSchedulePeriodRun,
  type ReportScheduleRunStatus,
  readProjectReportSchedule,
  type ScheduledReportFrequency,
} from './report-schedules.ts';

export const DEFAULT_REPORT_SCHEDULE_RUN_TIME = '10:00';
export const REPORT_SCHEDULE_RECENT_RUN_LIMIT = 8;

export interface ReportSchedulePeriodRunSummary {
  readonly backfillRemaining: number;
  readonly pending: number;
  readonly retryExhausted: number;
  readonly retryWait: number;
  readonly running: number;
  readonly skipped: number;
  readonly succeeded: number;
}

export interface ProjectReportScheduleSettingsView {
  readonly frequency: ReportScheduleFrequency;
  readonly lastError: string | null;
  readonly lastFailedAt: string | null;
  readonly lastStartedAt: string | null;
  readonly lastSucceededAt: string | null;
  readonly nextRunAt: string | null;
  readonly periodRunSummary: ReportSchedulePeriodRunSummary;
  readonly recentPeriodRuns: readonly ReportSchedulePeriodRun[];
  readonly retryCount: number;
  readonly runTime: string;
  readonly scheduleId: string | null;
  readonly timezone: typeof REPORT_SCHEDULE_TIMEZONE;
}

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

const EMPTY_PERIOD_RUN_SUMMARY: ReportSchedulePeriodRunSummary = {
  backfillRemaining: 0,
  pending: 0,
  retryExhausted: 0,
  retryWait: 0,
  running: 0,
  skipped: 0,
  succeeded: 0,
};

export function parseReportScheduleFrequencyInput(value: string): ReportScheduleFrequency {
  if (!isReportScheduleFrequency(value)) {
    throw new Error('frequency must be one of none, weekly, monthly, or annually.');
  }
  return value;
}

export function createDefaultReportScheduleSettingsView(): ProjectReportScheduleSettingsView {
  return {
    frequency: 'none',
    lastError: null,
    lastFailedAt: null,
    lastStartedAt: null,
    lastSucceededAt: null,
    nextRunAt: null,
    periodRunSummary: EMPTY_PERIOD_RUN_SUMMARY,
    recentPeriodRuns: [],
    retryCount: 0,
    runTime: DEFAULT_REPORT_SCHEDULE_RUN_TIME,
    scheduleId: null,
    timezone: REPORT_SCHEDULE_TIMEZONE,
  };
}

export function buildReportScheduleSettingsView(input: {
  readonly periodRunSummary: ReportSchedulePeriodRunSummary;
  readonly recentPeriodRuns: readonly ReportSchedulePeriodRun[];
  readonly schedule: ProjectReportSchedule | null;
}): ProjectReportScheduleSettingsView {
  if (!input.schedule) {
    return createDefaultReportScheduleSettingsView();
  }
  return {
    frequency: input.schedule.frequency,
    lastError: input.schedule.lastError,
    lastFailedAt: input.schedule.lastFailedAt,
    lastStartedAt: input.schedule.lastStartedAt,
    lastSucceededAt: input.schedule.lastSucceededAt,
    nextRunAt: input.schedule.nextRunAt,
    periodRunSummary: input.periodRunSummary,
    recentPeriodRuns: input.recentPeriodRuns,
    retryCount: input.schedule.retryCount,
    runTime: input.schedule.runTime,
    scheduleId: input.schedule.id,
    timezone: input.schedule.timezone,
  };
}

export function resolveReportScheduleNextRunAt(input: {
  readonly asOf: Date | string;
  readonly frequency: ReportScheduleFrequency;
  readonly runTime: string;
}): string | null {
  if (!isScheduledReportFrequency(input.frequency)) {
    return null;
  }
  return resolveNextScheduledReportRunAt({
    asOf: input.asOf,
    frequency: input.frequency,
    runTime: input.runTime,
  });
}

export function shouldResetReportScheduleExecutionState(input: {
  readonly nextFrequency: ReportScheduleFrequency;
  readonly previousFrequency: ReportScheduleFrequency | null;
}): boolean {
  return input.previousFrequency !== input.nextFrequency;
}

export class ReportScheduleSaveBlockedError extends Error {
  constructor() {
    super('定期レポートの実行処理が進行中です。処理完了後に再度お試しください。');
    this.name = 'ReportScheduleSaveBlockedError';
  }
}

export function hasActiveReportScheduleLease(
  schedule: Pick<ProjectReportSchedule, 'leaseExpiresAt' | 'workerToken'> | null,
  asOf: Date | string = new Date(),
): boolean {
  if (!schedule?.workerToken || !schedule.leaseExpiresAt) {
    return false;
  }
  return new Date(schedule.leaseExpiresAt).valueOf() > new Date(asOf).valueOf();
}

export function assertReportScheduleSaveAllowed(
  schedule: ProjectReportSchedule | null,
  asOf: Date | string = new Date(),
): void {
  if (hasActiveReportScheduleLease(schedule, asOf)) {
    throw new ReportScheduleSaveBlockedError();
  }
}

export async function readProjectReportScheduleSettings(
  sql: SqlExecutor,
  input: { readonly projectId: string },
): Promise<ProjectReportScheduleSettingsView> {
  const schedule = await readProjectReportSchedule(sql, { projectId: input.projectId });
  if (!schedule) {
    return createDefaultReportScheduleSettingsView();
  }
  const [periodRunSummary, recentPeriodRuns] = await Promise.all([
    readReportSchedulePeriodRunSummary(sql, {
      projectId: input.projectId,
      scheduleId: schedule.id,
    }),
    listReportSchedulePeriodRuns(sql, {
      limit: REPORT_SCHEDULE_RECENT_RUN_LIMIT,
      projectId: input.projectId,
      scheduleId: schedule.id,
    }),
  ]);
  return buildReportScheduleSettingsView({
    periodRunSummary,
    recentPeriodRuns,
    schedule,
  });
}

export async function saveProjectReportSchedule(
  sql: postgres.Sql,
  input: {
    readonly asOf: Date;
    readonly frequency: ReportScheduleFrequency;
    readonly projectId: string;
    readonly updatedBy: string;
  },
): Promise<ProjectReportSchedule> {
  return sql.begin(async (tx) => {
    await lockProjectRowForReportScheduleSave(tx, { projectId: input.projectId });
    const existing = await readLockedProjectReportSchedule(tx, { projectId: input.projectId });
    assertReportScheduleSaveAllowed(existing, input.asOf);

    const previousFrequency = existing?.frequency ?? null;
    const runTime = existing?.runTime ?? DEFAULT_REPORT_SCHEDULE_RUN_TIME;
    const nextRunAt = resolveReportScheduleNextRunAt({
      asOf: input.asOf,
      frequency: input.frequency,
      runTime,
    });
    const enqueueBackfill =
      isScheduledReportFrequency(input.frequency) &&
      shouldEnqueueInitialReportBackfill({
        hasScheduledReportForFrequency: await hasScheduledReportForFrequency(tx, {
          frequency: input.frequency,
          projectId: input.projectId,
        }),
        nextFrequency: input.frequency,
        previousFrequency,
      });
    const schedule = await upsertProjectReportScheduleRow(tx, {
      frequency: input.frequency,
      nextRunAt,
      previousFrequency,
      projectId: input.projectId,
      runTime,
      updatedBy: input.updatedBy,
    });
    if (enqueueBackfill) {
      await enqueueInitialBackfillPeriodRuns(tx, {
        asOf: input.asOf,
        frequency: input.frequency,
        projectId: input.projectId,
        scheduleId: schedule.id,
      });
    }
    return schedule;
  });
}

async function lockProjectRowForReportScheduleSave(
  sql: SqlExecutor,
  input: { readonly projectId: string },
): Promise<void> {
  const rows = (await sql`
    SELECT project.id::text AS id
    FROM public.projects AS project
    WHERE project.id = ${input.projectId}
    FOR UPDATE
  `) as readonly unknown[];
  const row = rows[0] ? requireRecord(rows[0], 'project lock') : undefined;
  if (!row || typeof row.id !== 'string' || row.id !== input.projectId) {
    throw new Error('Project not found.');
  }
}

async function readLockedProjectReportSchedule(
  sql: SqlExecutor,
  input: { readonly projectId: string },
): Promise<ProjectReportSchedule | null> {
  const rows = (await sql`
    SELECT
      schedule.id::text AS id,
      schedule.project_id::text AS "projectId",
      schedule.frequency,
      schedule.timezone,
      to_char(schedule.run_time, 'HH24:MI') AS "runTime",
      schedule.next_run_at AS "nextRunAt",
      schedule.last_started_at AS "lastStartedAt",
      schedule.last_succeeded_at AS "lastSucceededAt",
      schedule.last_failed_at AS "lastFailedAt",
      schedule.retry_count AS "retryCount",
      schedule.last_error AS "lastError",
      schedule.worker_token AS "workerToken",
      schedule.lease_expires_at AS "leaseExpiresAt",
      schedule.created_by::text AS "createdBy",
      schedule.updated_by::text AS "updatedBy",
      schedule.created_at AS "createdAt",
      schedule.updated_at AS "updatedAt"
    FROM public.project_report_schedules AS schedule
    JOIN public.projects AS project ON project.id = schedule.project_id
    WHERE schedule.project_id = ${input.projectId}
      AND project.id = ${input.projectId}
    FOR UPDATE OF schedule
  `) as readonly unknown[];
  return rows[0] ? parseProjectReportScheduleRow(rows[0]) : null;
}

async function upsertProjectReportScheduleRow(
  sql: SqlExecutor,
  input: {
    readonly frequency: ReportScheduleFrequency;
    readonly nextRunAt: string | null;
    readonly previousFrequency: ReportScheduleFrequency | null;
    readonly projectId: string;
    readonly runTime: string;
    readonly updatedBy: string;
  },
): Promise<ProjectReportSchedule> {
  const frequencyChanged = shouldResetReportScheduleExecutionState({
    nextFrequency: input.frequency,
    previousFrequency: input.previousFrequency,
  });
  const rows = (await sql`
    INSERT INTO public.project_report_schedules (
      project_id,
      frequency,
      timezone,
      run_time,
      next_run_at,
      created_by,
      updated_by
    )
    VALUES (
      ${input.projectId},
      ${input.frequency},
      ${REPORT_SCHEDULE_TIMEZONE},
      ${input.runTime}::time,
      ${input.nextRunAt},
      ${input.updatedBy},
      ${input.updatedBy}
    )
    ON CONFLICT (project_id) DO UPDATE SET
      frequency = EXCLUDED.frequency,
      next_run_at = EXCLUDED.next_run_at,
      worker_token = CASE
        WHEN ${frequencyChanged} THEN NULL
        WHEN public.project_report_schedules.lease_expires_at IS NOT NULL
          AND public.project_report_schedules.lease_expires_at <= now() THEN NULL
        ELSE public.project_report_schedules.worker_token
      END,
      lease_expires_at = CASE
        WHEN ${frequencyChanged} THEN NULL
        WHEN public.project_report_schedules.lease_expires_at IS NOT NULL
          AND public.project_report_schedules.lease_expires_at <= now() THEN NULL
        ELSE public.project_report_schedules.lease_expires_at
      END,
      retry_count = CASE
        WHEN ${frequencyChanged} THEN 0
        ELSE public.project_report_schedules.retry_count
      END,
      last_error = CASE
        WHEN ${frequencyChanged} THEN NULL
        ELSE public.project_report_schedules.last_error
      END,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    RETURNING
      id::text AS id,
      project_id::text AS "projectId",
      frequency,
      timezone,
      to_char(run_time, 'HH24:MI') AS "runTime",
      next_run_at AS "nextRunAt",
      last_started_at AS "lastStartedAt",
      last_succeeded_at AS "lastSucceededAt",
      last_failed_at AS "lastFailedAt",
      retry_count AS "retryCount",
      last_error AS "lastError",
      worker_token AS "workerToken",
      lease_expires_at AS "leaseExpiresAt",
      created_by::text AS "createdBy",
      updated_by::text AS "updatedBy",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `) as readonly unknown[];
  const schedule = rows[0] ? parseProjectReportScheduleRow(rows[0]) : undefined;
  if (!schedule) {
    throw new Error('Project report schedule could not be saved.');
  }
  return schedule;
}

async function enqueueInitialBackfillPeriodRuns(
  sql: SqlExecutor,
  input: {
    readonly asOf: Date;
    readonly frequency: ScheduledReportFrequency;
    readonly projectId: string;
    readonly scheduleId: string;
  },
): Promise<void> {
  const availableFrom = await readProjectReportAvailableFrom(sql, { projectId: input.projectId });
  if (!availableFrom) {
    return;
  }

  let periodStartCursor: string | undefined;
  let hasMore = true;
  while (hasMore) {
    const enumeration = enumerateBackfillScheduledReportPeriods({
      asOf: input.asOf.toISOString(),
      availableFrom,
      frequency: input.frequency,
      limit: MAX_REPORT_PERIOD_ENUMERATION,
      periodStartCursor,
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
          ${input.scheduleId},
          ${input.projectId},
          ${input.frequency},
          ${period.start}::date,
          ${period.end}::date,
          'scheduled_backfill',
          'pending'
        )
        ON CONFLICT (project_id, frequency, period_start, period_end) DO NOTHING
      `;
    }
    hasMore = enumeration.hasMore;
    periodStartCursor = enumeration.nextPeriodStart ?? undefined;
    if (!hasMore || !periodStartCursor) {
      break;
    }
  }
}

export async function readReportSchedulePeriodRunSummary(
  sql: SqlExecutor,
  input: { readonly projectId: string; readonly scheduleId: string },
): Promise<ReportSchedulePeriodRunSummary> {
  const rows = (await sql`
    SELECT
      count(*) FILTER (WHERE period_run.status = 'pending')::int AS pending,
      count(*) FILTER (WHERE period_run.status = 'running')::int AS running,
      count(*) FILTER (WHERE period_run.status = 'retry_wait')::int AS "retryWait",
      count(*) FILTER (WHERE period_run.status = 'retry_exhausted')::int AS "retryExhausted",
      count(*) FILTER (WHERE period_run.status = 'skipped')::int AS skipped,
      count(*) FILTER (WHERE period_run.status = 'succeeded')::int AS succeeded,
      count(*) FILTER (
        WHERE period_run.run_kind = 'scheduled_backfill'
          AND period_run.status NOT IN ('succeeded', 'skipped')
      )::int AS "backfillRemaining"
    FROM public.report_schedule_period_runs AS period_run
    JOIN public.project_report_schedules AS schedule
      ON schedule.id = period_run.schedule_id
     AND schedule.project_id = period_run.project_id
    WHERE period_run.project_id = ${input.projectId}
      AND period_run.schedule_id = ${input.scheduleId}
      AND schedule.project_id = ${input.projectId}
  `) as readonly unknown[];
  return rows[0] ? parseReportSchedulePeriodRunSummaryRow(rows[0]) : EMPTY_PERIOD_RUN_SUMMARY;
}

export function parseReportSchedulePeriodRunSummaryRow(
  value: unknown,
): ReportSchedulePeriodRunSummary {
  const row = requireRecord(value, 'report schedule period run summary');
  return {
    backfillRemaining: requireNonNegativeInteger(row.backfillRemaining, 'backfillRemaining'),
    pending: requireNonNegativeInteger(row.pending, 'pending'),
    retryExhausted: requireNonNegativeInteger(row.retryExhausted, 'retryExhausted'),
    retryWait: requireNonNegativeInteger(row.retryWait, 'retryWait'),
    running: requireNonNegativeInteger(row.running, 'running'),
    skipped: requireNonNegativeInteger(row.skipped, 'skipped'),
    succeeded: requireNonNegativeInteger(row.succeeded, 'succeeded'),
  };
}

export function formatReportScheduleTimestamp(value: string | null): string {
  if (!value) {
    return '未設定';
  }
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: REPORT_SCHEDULE_TIMEZONE,
  }).format(new Date(value));
}

export function reportScheduleFrequencyLabel(frequency: ReportScheduleFrequency): string {
  switch (frequency) {
    case 'weekly':
      return '週次';
    case 'monthly':
      return '月次';
    case 'annually':
      return '年次';
    default:
      return 'なし';
  }
}

export function reportSchedulePeriodRunStatusLabel(status: ReportScheduleRunStatus): string {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'running':
      return 'running';
    case 'retry_wait':
      return 'retry_wait';
    case 'retry_exhausted':
      return 'retry_exhausted';
    case 'skipped':
      return 'skipped';
    case 'succeeded':
      return 'succeeded';
    default:
      return status;
  }
}

export function describeReportScheduleActivation(input: {
  readonly frequency: ReportScheduleFrequency;
  readonly previousFrequency: ReportScheduleFrequency | null;
}): string | null {
  const isFirstActivation =
    (input.previousFrequency === null || input.previousFrequency === 'none') &&
    input.frequency !== 'none';
  if (isFirstActivation) {
    return '初回の有効化では、完了済みの過去期間を非同期で backfill します。現在進行中の期間は対象外です。';
  }
  if (
    input.previousFrequency !== null &&
    input.previousFrequency !== 'none' &&
    input.frequency !== 'none' &&
    input.previousFrequency !== input.frequency
  ) {
    return '周期を変更しても即時 backfill は行わず、次回の定期実行から新しい周期が反映されます。';
  }
  return null;
}

function requireRecord(value: unknown, kind: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${kind} row.`);
  }
  return value as Record<string, unknown>;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid report schedule settings field: ${field}`);
  }
  return value;
}
