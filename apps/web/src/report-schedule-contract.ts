/**
 * Client-safe report schedule contract shared by UI, server actions, and SQL modules.
 *
 * This module must not import postgres, SQL repositories, or Next.js server-only code.
 */

/** IANA timezone used for all report schedule wall-clock calculations and display. */
export const REPORT_SCHEDULE_TIMEZONE = 'Asia/Tokyo';

/** Default daily run time for schedules that do not yet have a persisted run_time value. */
export const DEFAULT_REPORT_SCHEDULE_RUN_TIME = '10:00';

/**
 * Persisted schedule cadence for a project.
 *
 * `none` disables future runs while retaining historical period-run rows for audit.
 */
export type ReportScheduleFrequency = 'annually' | 'monthly' | 'none' | 'weekly';

/** Frequencies that enqueue or execute scheduled report period runs. */
export type ScheduledReportFrequency = Exclude<ReportScheduleFrequency, 'none'>;

/**
 * Origin of a period run: a regular dispatcher slot or a one-time historical backfill enqueue.
 */
export type ReportScheduleRunKind = 'scheduled' | 'scheduled_backfill';

/**
 * Dispatcher lifecycle state for a single period run.
 *
 * Terminal states are `succeeded`, `skipped`, and `retry_exhausted`.
 */
export type ReportScheduleRunStatus =
  | 'pending'
  | 'retry_exhausted'
  | 'retry_wait'
  | 'running'
  | 'skipped'
  | 'succeeded';

/** A single scheduled or backfill period run tracked for a project report schedule. */
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
