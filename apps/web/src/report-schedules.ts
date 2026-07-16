import type postgres from 'postgres';

export const REPORT_SCHEDULE_TIMEZONE = 'Asia/Tokyo';

export type ReportScheduleFrequency = 'annually' | 'monthly' | 'none' | 'weekly';
export type ScheduledReportFrequency = Exclude<ReportScheduleFrequency, 'none'>;
export type ReportScheduleRunKind = 'scheduled' | 'scheduled_backfill';
export type ReportScheduleRunStatus =
  | 'pending'
  | 'retry_exhausted'
  | 'retry_wait'
  | 'running'
  | 'skipped'
  | 'succeeded';

export interface ProjectReportSchedule {
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly frequency: ReportScheduleFrequency;
  readonly id: string;
  readonly lastError: string | null;
  readonly lastFailedAt: string | null;
  readonly lastStartedAt: string | null;
  readonly lastSucceededAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly nextRunAt: string | null;
  readonly projectId: string;
  readonly retryCount: number;
  readonly runTime: string;
  readonly timezone: typeof REPORT_SCHEDULE_TIMEZONE;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
  readonly workerToken: string | null;
}

export interface ReportSchedulePeriodRun {
  readonly attemptCount: number;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly frequency: ScheduledReportFrequency;
  readonly id: string;
  readonly lastError: string | null;
  readonly leaseExpiresAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly notificationSentAt: string | null;
  readonly periodEnd: string;
  readonly periodStart: string;
  readonly projectId: string;
  readonly reportId: string | null;
  readonly runKind: ReportScheduleRunKind;
  readonly scheduleId: string;
  readonly skipReason: string | null;
  readonly startedAt: string | null;
  readonly status: ReportScheduleRunStatus;
  readonly updatedAt: string;
  readonly workerToken: string | null;
}

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

const REPORT_SCHEDULE_FREQUENCIES: ReadonlySet<string> = new Set([
  'none',
  'weekly',
  'monthly',
  'annually',
]);
const SCHEDULED_REPORT_FREQUENCIES: ReadonlySet<string> = new Set([
  'weekly',
  'monthly',
  'annually',
]);
const REPORT_SCHEDULE_RUN_KINDS: ReadonlySet<string> = new Set(['scheduled', 'scheduled_backfill']);
const REPORT_SCHEDULE_RUN_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'succeeded',
  'skipped',
  'retry_wait',
  'retry_exhausted',
]);

export function isReportScheduleFrequency(value: unknown): value is ReportScheduleFrequency {
  return typeof value === 'string' && REPORT_SCHEDULE_FREQUENCIES.has(value);
}

export function isScheduledReportFrequency(value: unknown): value is ScheduledReportFrequency {
  return typeof value === 'string' && SCHEDULED_REPORT_FREQUENCIES.has(value);
}

export function isReportScheduleRunKind(value: unknown): value is ReportScheduleRunKind {
  return typeof value === 'string' && REPORT_SCHEDULE_RUN_KINDS.has(value);
}

export function isReportScheduleRunStatus(value: unknown): value is ReportScheduleRunStatus {
  return typeof value === 'string' && REPORT_SCHEDULE_RUN_STATUSES.has(value);
}

export function parseProjectReportScheduleRow(value: unknown): ProjectReportSchedule {
  const row = requireRecord(value, 'project report schedule');
  const frequency = requireReportScheduleFrequency(row.frequency);
  const nextRunAt = optionalTimestamp(row.nextRunAt, 'nextRunAt');
  const workerToken = optionalBoundedString(row.workerToken, 'workerToken');
  const leaseExpiresAt = optionalTimestamp(row.leaseExpiresAt, 'leaseExpiresAt');

  if ((frequency === 'none') !== (nextRunAt === null)) {
    throw new Error('Invalid project report schedule row: frequency and nextRunAt disagree.');
  }
  requireLeasePair(workerToken, leaseExpiresAt, 'project report schedule');

  return {
    createdAt: requireTimestamp(row.createdAt, 'createdAt'),
    createdBy: optionalIdentifier(row.createdBy, 'createdBy'),
    frequency,
    id: requireIdentifier(row.id, 'id'),
    lastError: optionalBoundedString(row.lastError, 'lastError', 1000),
    lastFailedAt: optionalTimestamp(row.lastFailedAt, 'lastFailedAt'),
    lastStartedAt: optionalTimestamp(row.lastStartedAt, 'lastStartedAt'),
    lastSucceededAt: optionalTimestamp(row.lastSucceededAt, 'lastSucceededAt'),
    leaseExpiresAt,
    nextRunAt,
    projectId: requireIdentifier(row.projectId, 'projectId'),
    retryCount: requireNonNegativeInteger(row.retryCount, 'retryCount'),
    runTime: requireTime(row.runTime, 'runTime'),
    timezone: requireTimezone(row.timezone),
    updatedAt: requireTimestamp(row.updatedAt, 'updatedAt'),
    updatedBy: optionalIdentifier(row.updatedBy, 'updatedBy'),
    workerToken,
  };
}

export function parseReportSchedulePeriodRunRow(value: unknown): ReportSchedulePeriodRun {
  const row = requireRecord(value, 'report schedule period run');
  const status = requireReportScheduleRunStatus(row.status);
  const reportId = optionalIdentifier(row.reportId, 'reportId');
  const skipReason = optionalBoundedString(row.skipReason, 'skipReason', 1000);
  const completedAt = optionalTimestamp(row.completedAt, 'completedAt');
  const nextAttemptAt = optionalTimestamp(row.nextAttemptAt, 'nextAttemptAt');
  const workerToken = optionalBoundedString(row.workerToken, 'workerToken');
  const leaseExpiresAt = optionalTimestamp(row.leaseExpiresAt, 'leaseExpiresAt');

  if (status === 'skipped' && (reportId !== null || skipReason === null || completedAt === null)) {
    throw new Error('Invalid report schedule period run row: skipped state is incomplete.');
  }
  if (status === 'succeeded' && (reportId === null || completedAt === null)) {
    throw new Error(
      'Invalid report schedule period run row: succeeded state requires reportId and completedAt.',
    );
  }
  if (status !== 'succeeded' && reportId !== null) {
    throw new Error(
      'Invalid report schedule period run row: reportId is only allowed for succeeded runs.',
    );
  }
  if (status === 'retry_wait' && nextAttemptAt === null) {
    throw new Error('Invalid report schedule period run row: retry_wait requires nextAttemptAt.');
  }
  requireLeasePair(workerToken, leaseExpiresAt, 'report schedule period run');

  const periodStart = requireDate(row.periodStart, 'periodStart');
  const periodEnd = requireDate(row.periodEnd, 'periodEnd');
  if (periodStart > periodEnd) {
    throw new Error('Invalid report schedule period run row: periodStart is after periodEnd.');
  }

  return {
    attemptCount: requireNonNegativeInteger(row.attemptCount, 'attemptCount'),
    completedAt,
    createdAt: requireTimestamp(row.createdAt, 'createdAt'),
    frequency: requireScheduledReportFrequency(row.frequency),
    id: requireIdentifier(row.id, 'id'),
    lastError: optionalBoundedString(row.lastError, 'lastError', 1000),
    leaseExpiresAt,
    nextAttemptAt,
    notificationSentAt: optionalTimestamp(row.notificationSentAt, 'notificationSentAt'),
    periodEnd,
    periodStart,
    projectId: requireIdentifier(row.projectId, 'projectId'),
    reportId,
    runKind: requireReportScheduleRunKind(row.runKind),
    scheduleId: requireIdentifier(row.scheduleId, 'scheduleId'),
    skipReason,
    startedAt: optionalTimestamp(row.startedAt, 'startedAt'),
    status,
    updatedAt: requireTimestamp(row.updatedAt, 'updatedAt'),
    workerToken,
  };
}

export async function readProjectReportSchedule(
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
    LIMIT 1
  `) as readonly unknown[];
  return rows[0] ? parseProjectReportScheduleRow(rows[0]) : null;
}

export async function readReportSchedulePeriodRun(
  sql: SqlExecutor,
  input: { readonly periodRunId: string; readonly projectId: string },
): Promise<ReportSchedulePeriodRun | null> {
  const rows = (await sql`
    ${periodRunSelectColumns(sql)}
    FROM public.report_schedule_period_runs AS period_run
    JOIN public.project_report_schedules AS schedule
      ON schedule.id = period_run.schedule_id
     AND schedule.project_id = period_run.project_id
    WHERE period_run.id = ${input.periodRunId}
      AND period_run.project_id = ${input.projectId}
      AND schedule.project_id = ${input.projectId}
    LIMIT 1
  `) as readonly unknown[];
  return rows[0] ? parseReportSchedulePeriodRunRow(rows[0]) : null;
}

export async function listReportSchedulePeriodRuns(
  sql: SqlExecutor,
  input: { readonly limit: number; readonly projectId: string; readonly scheduleId: string },
): Promise<readonly ReportSchedulePeriodRun[]> {
  const limit = requirePositiveInteger(input.limit, 'limit');
  const rows = (await sql`
    ${periodRunSelectColumns(sql)}
    FROM public.report_schedule_period_runs AS period_run
    JOIN public.project_report_schedules AS schedule
      ON schedule.id = period_run.schedule_id
     AND schedule.project_id = period_run.project_id
    WHERE period_run.project_id = ${input.projectId}
      AND period_run.schedule_id = ${input.scheduleId}
      AND schedule.project_id = ${input.projectId}
    ORDER BY period_run.period_start DESC, period_run.id
    LIMIT ${limit}
  `) as readonly unknown[];
  return rows.map((row) => parseReportSchedulePeriodRunRow(row));
}

function periodRunSelectColumns(sql: SqlExecutor): ReturnType<SqlExecutor> {
  return sql`
    SELECT
      period_run.id::text AS id,
      period_run.schedule_id::text AS "scheduleId",
      period_run.project_id::text AS "projectId",
      period_run.frequency,
      period_run.period_start::text AS "periodStart",
      period_run.period_end::text AS "periodEnd",
      period_run.run_kind AS "runKind",
      period_run.status,
      period_run.attempt_count AS "attemptCount",
      period_run.next_attempt_at AS "nextAttemptAt",
      period_run.last_error AS "lastError",
      period_run.worker_token AS "workerToken",
      period_run.lease_expires_at AS "leaseExpiresAt",
      period_run.report_id::text AS "reportId",
      period_run.skip_reason AS "skipReason",
      period_run.notification_sent_at AS "notificationSentAt",
      period_run.created_at AS "createdAt",
      period_run.updated_at AS "updatedAt",
      period_run.started_at AS "startedAt",
      period_run.completed_at AS "completedAt"
  `;
}

function requireRecord(value: unknown, kind: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${kind} row.`);
  }
  return value as Record<string, unknown>;
}

function requireReportScheduleFrequency(value: unknown): ReportScheduleFrequency {
  if (!isReportScheduleFrequency(value)) {
    throw new Error('Invalid project report schedule field: frequency');
  }
  return value;
}

function requireScheduledReportFrequency(value: unknown): ScheduledReportFrequency {
  if (!isScheduledReportFrequency(value)) {
    throw new Error('Invalid report schedule period run field: frequency');
  }
  return value;
}

function requireReportScheduleRunKind(value: unknown): ReportScheduleRunKind {
  if (!isReportScheduleRunKind(value)) {
    throw new Error('Invalid report schedule period run field: runKind');
  }
  return value;
}

function requireReportScheduleRunStatus(value: unknown): ReportScheduleRunStatus {
  if (!isReportScheduleRunStatus(value)) {
    throw new Error('Invalid report schedule period run field: status');
  }
  return value;
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid report schedule field: ${field}`);
  }
  return value;
}

function optionalIdentifier(value: unknown, field: string): string | null {
  return value === null ? null : requireIdentifier(value, field);
}

function optionalBoundedString(value: unknown, field: string, maximum = 500): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`Invalid report schedule field: ${field}`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(requireIdentifier(value, field));
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Invalid report schedule field: ${field}`);
  }
  return date.toISOString();
}

function optionalTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : requireTimestamp(value, field);
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid report schedule field: ${field}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid report schedule field: ${field}`);
  }
  return value;
}

function requireTime(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid report schedule field: ${field}`);
  }
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) {
    throw new Error(`Invalid report schedule field: ${field}`);
  }
  return `${match[1]}:${match[2]}`;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid report schedule field: ${field}`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid report schedule field: ${field}`);
  }
  return value;
}

function requireTimezone(value: unknown): typeof REPORT_SCHEDULE_TIMEZONE {
  if (value !== REPORT_SCHEDULE_TIMEZONE) {
    throw new Error('Invalid project report schedule field: timezone');
  }
  return value;
}

function requireLeasePair(
  workerToken: string | null,
  leaseExpiresAt: string | null,
  kind: string,
): void {
  if ((workerToken === null) !== (leaseExpiresAt === null)) {
    throw new Error(`Invalid ${kind} row: lease pair is incomplete.`);
  }
}
