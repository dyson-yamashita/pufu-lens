import type postgres from 'postgres';
import { REPORT_SCHEDULE_TIMEZONE, type ScheduledReportFrequency } from './report-schedules.ts';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export interface PreviousScheduledReport {
  readonly id: string;
  readonly periodEnd: string;
  readonly periodStart: string;
  readonly storageUri: string;
}

export async function hasScheduledReportForFrequency(
  sql: SqlExecutor,
  input: { readonly frequency: ScheduledReportFrequency; readonly projectId: string },
): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1
      FROM public.reports AS report
      WHERE report.project_id = ${input.projectId}
        AND report.schedule_frequency = ${input.frequency}
        AND report.generation_kind IN ('scheduled', 'scheduled_backfill')
    ) AS "hasReport"
  `) as readonly unknown[];
  const row = requireRecord(rows[0], 'scheduled report existence');
  if (typeof row.hasReport !== 'boolean') {
    throw new Error('Invalid scheduled report existence row: hasReport');
  }
  return row.hasReport;
}

export async function readPreviousScheduledReport(
  sql: SqlExecutor,
  input: {
    readonly beforePeriodStart: string;
    readonly frequency: ScheduledReportFrequency;
    readonly projectId: string;
  },
): Promise<PreviousScheduledReport | null> {
  const beforePeriodStart = requireDate(input.beforePeriodStart, 'beforePeriodStart');
  const rows = (await sql`
    SELECT
      report.id::text AS id,
      lower(report.period)::text AS "periodStart",
      (upper(report.period) - 1)::text AS "periodEnd",
      report.storage_uri AS "storageUri"
    FROM public.reports AS report
    WHERE report.project_id = ${input.projectId}
      AND report.schedule_frequency = ${input.frequency}
      AND report.generation_kind IN ('scheduled', 'scheduled_backfill')
      AND upper(report.period) <= ${beforePeriodStart}::date
    ORDER BY upper(report.period) DESC, lower(report.period) DESC, report.created_at DESC, report.id
    LIMIT 1
  `) as readonly unknown[];
  return rows[0] ? parsePreviousScheduledReportRow(rows[0]) : null;
}

export async function readProjectReportAvailableFrom(
  sql: SqlExecutor,
  input: { readonly projectId: string },
): Promise<string | null> {
  const rows = (await sql`
    SELECT (
      LEAST(
        project.created_at,
        COALESCE((
          SELECT min(document.occurred_at)
          FROM public.documents AS document
          WHERE document.project_id = ${input.projectId}
        ), 'infinity'::timestamptz),
        COALESCE((
          SELECT min(link.first_seen_at)
          FROM public.raw_document_data_sources AS link
          WHERE link.project_id = ${input.projectId}
        ), 'infinity'::timestamptz)
      ) AT TIME ZONE ${REPORT_SCHEDULE_TIMEZONE}
    )::date::text AS "availableFrom"
    FROM public.projects AS project
    WHERE project.id = ${input.projectId}
    LIMIT 1
  `) as readonly unknown[];
  if (!rows[0]) return null;
  const row = requireRecord(rows[0], 'report available-from');
  return requireDate(row.availableFrom, 'availableFrom');
}

export function parsePreviousScheduledReportRow(value: unknown): PreviousScheduledReport {
  const row = requireRecord(value, 'previous scheduled report');
  const periodStart = requireDate(row.periodStart, 'periodStart');
  const periodEnd = requireDate(row.periodEnd, 'periodEnd');
  if (periodStart > periodEnd) {
    throw new Error('Invalid previous scheduled report row: periodStart is after periodEnd.');
  }
  return {
    id: requireIdentifier(row.id, 'id'),
    periodEnd,
    periodStart,
    storageUri: requireIdentifier(row.storageUri, 'storageUri'),
  };
}

function requireRecord(value: unknown, kind: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${kind} row.`);
  }
  return value as Record<string, unknown>;
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid previous scheduled report field: ${field}`);
  }
  return value;
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid report schedule planning field: ${field}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid report schedule planning field: ${field}`);
  }
  return value;
}
