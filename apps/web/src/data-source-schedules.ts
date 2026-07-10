import type postgres from 'postgres';
import type { SourceType } from './admin-data.ts';

export const DEFAULT_SCHEDULE_TIME = '10:00';
export const SCHEDULE_TIMEZONE = 'Asia/Tokyo';

export interface DataSourceScheduleSummary {
  readonly dailyTime: string;
  readonly enabled: boolean;
  readonly lastError: string | null;
  readonly lastFailedAt: string | null;
  readonly lastSucceededAt: string | null;
  readonly nextRunAt: string;
  readonly retryCount: number;
  readonly timezone: typeof SCHEDULE_TIMEZONE;
}

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export function isSchedulableSourceType(sourceType: SourceType): boolean {
  return sourceType === 'github' || sourceType === 'drive' || sourceType === 'gmail';
}

export function requireDailyTime(value: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error('dailyTime must use HH:mm in the 24-hour clock.');
  }
  return value;
}

export function parseDataSourceScheduleRow(value: unknown): DataSourceScheduleSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid data source schedule row.');
  }
  const row = value;
  return {
    dailyTime: requireString(Reflect.get(row, 'dailyTime'), 'dailyTime').slice(0, 5),
    enabled: requireBoolean(Reflect.get(row, 'enabled'), 'enabled'),
    lastError: optionalString(Reflect.get(row, 'lastError'), 'lastError'),
    lastFailedAt: optionalTimestamp(Reflect.get(row, 'lastFailedAt'), 'lastFailedAt'),
    lastSucceededAt: optionalTimestamp(Reflect.get(row, 'lastSucceededAt'), 'lastSucceededAt'),
    nextRunAt: requireTimestamp(Reflect.get(row, 'nextRunAt'), 'nextRunAt'),
    retryCount: requireNonNegativeInteger(Reflect.get(row, 'retryCount'), 'retryCount'),
    timezone: requireTimezone(Reflect.get(row, 'timezone')),
  };
}

export async function insertDefaultDataSourceSchedule(
  sql: SqlExecutor,
  input: {
    readonly dataSourceId: string;
    readonly projectId: string;
    readonly sourceType: SourceType;
  },
): Promise<void> {
  if (!isSchedulableSourceType(input.sourceType)) return;
  await sql`
    INSERT INTO public.data_source_schedules (
      project_id, data_source_id, enabled, daily_time, timezone, next_run_at
    )
    VALUES (
      ${input.projectId}, ${input.dataSourceId}, true, TIME '10:00', 'Asia/Tokyo',
      (
        CASE
          WHEN (now() AT TIME ZONE 'Asia/Tokyo')::time < TIME '10:00'
            THEN (now() AT TIME ZONE 'Asia/Tokyo')::date
          ELSE (now() AT TIME ZONE 'Asia/Tokyo')::date + 1
        END + TIME '10:00'
      ) AT TIME ZONE 'Asia/Tokyo'
    )
  `;
}

export async function readDataSourceSchedule(
  sql: SqlExecutor,
  input: { readonly dataSourceId: string; readonly projectId: string },
): Promise<DataSourceScheduleSummary | null> {
  const rows = (await sql`
    SELECT
      schedule.enabled,
      to_char(schedule.daily_time, 'HH24:MI') AS "dailyTime",
      schedule.timezone,
      schedule.next_run_at AS "nextRunAt",
      schedule.last_succeeded_at AS "lastSucceededAt",
      schedule.last_failed_at AS "lastFailedAt",
      schedule.retry_count AS "retryCount",
      schedule.last_error AS "lastError"
    FROM public.data_source_schedules AS schedule
    JOIN public.data_sources AS source
      ON source.id = schedule.data_source_id
     AND source.project_id = schedule.project_id
    WHERE schedule.project_id = ${input.projectId}
      AND schedule.data_source_id = ${input.dataSourceId}
      AND source.source_type IN ('github', 'drive', 'gmail')
    LIMIT 1
  `) as readonly unknown[];
  return rows[0] ? parseDataSourceScheduleRow(rows[0]) : null;
}

export async function updateDataSourceScheduleRow(
  sql: SqlExecutor,
  input: {
    readonly dailyTime: string;
    readonly dataSourceId: string;
    readonly enabled: boolean;
    readonly projectId: string;
  },
): Promise<DataSourceScheduleSummary | null> {
  const dailyTime = requireDailyTime(input.dailyTime);
  const rows = (await sql`
    UPDATE public.data_source_schedules AS schedule
    SET
      enabled = ${input.enabled},
      daily_time = ${dailyTime}::time,
      next_run_at = (
        CASE
          WHEN (now() AT TIME ZONE 'Asia/Tokyo')::time < ${dailyTime}::time
            THEN (now() AT TIME ZONE 'Asia/Tokyo')::date
          ELSE (now() AT TIME ZONE 'Asia/Tokyo')::date + 1
        END + ${dailyTime}::time
      ) AT TIME ZONE 'Asia/Tokyo',
      retry_count = 0,
      last_error = NULL,
      updated_at = now()
    FROM public.data_sources AS source
    WHERE schedule.project_id = ${input.projectId}
      AND schedule.data_source_id = ${input.dataSourceId}
      AND source.id = schedule.data_source_id
      AND source.project_id = schedule.project_id
      AND source.source_type IN ('github', 'drive', 'gmail')
    RETURNING
      schedule.enabled,
      to_char(schedule.daily_time, 'HH24:MI') AS "dailyTime",
      schedule.timezone,
      schedule.next_run_at AS "nextRunAt",
      schedule.last_succeeded_at AS "lastSucceededAt",
      schedule.last_failed_at AS "lastFailedAt",
      schedule.retry_count AS "retryCount",
      schedule.last_error AS "lastError"
  `) as readonly unknown[];
  return rows[0] ? parseDataSourceScheduleRow(rows[0]) : null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid schedule row field: ${field}`);
  return value;
}
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid schedule row field: ${field}`);
  return value;
}
function optionalString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireString(value, field);
}
function requireTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(requireString(value, field));
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid schedule row field: ${field}`);
  return date.toISOString();
}
function optionalTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : requireTimestamp(value, field);
}
function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid schedule row field: ${field}`);
  }
  return value;
}
function requireTimezone(value: unknown): typeof SCHEDULE_TIMEZONE {
  if (value !== SCHEDULE_TIMEZONE) throw new Error('Invalid schedule row field: timezone');
  return value;
}
