import {
  REPORT_SCHEDULE_TIMEZONE,
  type ReportScheduleFrequency,
  type ReportSchedulePeriodRun,
  type ReportScheduleRunStatus,
} from './report-schedule-contract.ts';

export { DEFAULT_REPORT_SCHEDULE_RUN_TIME } from './report-schedule-contract.ts';

/**
 * Status counts for period runs that match the schedule's current frequency.
 *
 * Older-frequency unfinished rows are excluded so summary totals reflect the active cadence only.
 */
export interface ReportSchedulePeriodRunSummary {
  readonly backfillRemaining: number;
  readonly pending: number;
  readonly retryExhausted: number;
  readonly retryWait: number;
  readonly running: number;
  readonly skipped: number;
  readonly succeeded: number;
}

/** Read model for project report schedule settings shown in the reports UI. */
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

/**
 * Formats a report schedule timestamp for display.
 *
 * @param value - The timestamp to format, or `null` for an unset value
 * @returns The formatted timestamp in the report schedule timezone, or `未設定` when no value is provided
 */
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

/**
 * Converts a report schedule frequency to its Japanese display label.
 *
 * @param frequency - The report schedule frequency to label
 * @returns The Japanese label for the frequency
 */
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

/**
 * Resolves a period run status to its display label.
 *
 * @param status - The period run status to label
 * @returns The status label, or the provided status for unrecognized values
 */
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

export type {
  ReportScheduleFrequency,
  ReportSchedulePeriodRun,
  ReportScheduleRunStatus,
} from './report-schedule-contract.ts';
