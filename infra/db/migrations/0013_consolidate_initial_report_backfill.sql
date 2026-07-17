-- Migration: 0013_consolidate_initial_report_backfill
-- Purpose: Consolidate untouched multi-row initial scheduled_backfill queues into one aggregate period.
-- Existing DB behavior:
--   - Issue #595 changes first activation to enqueue one aggregate historical period.
--   - Production may still have multiple pending scheduled_backfill rows created before that change.
-- Fresh DB sync:
--   - No schema DDL changes; add this version to the schema_migrations seed in init.sql.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Touches only schedule metadata and bounded operational columns; no raw content or secrets.

LOCK TABLE public.report_schedule_period_runs IN SHARE ROW EXCLUSIVE MODE;

WITH untouched_backfill_groups AS (
  SELECT
    period_run.schedule_id,
    period_run.project_id,
    period_run.frequency
  FROM public.report_schedule_period_runs AS period_run
  WHERE period_run.run_kind = 'scheduled_backfill'
  GROUP BY period_run.schedule_id, period_run.project_id, period_run.frequency
  HAVING count(*) > 1
    AND count(*) = count(*) FILTER (
      WHERE period_run.status = 'pending'
        AND period_run.attempt_count = 0
        AND period_run.next_attempt_at IS NULL
        AND period_run.last_error IS NULL
        AND period_run.worker_token IS NULL
        AND period_run.lease_expires_at IS NULL
        AND period_run.report_id IS NULL
        AND period_run.skip_reason IS NULL
        AND period_run.notification_sent_at IS NULL
        AND period_run.started_at IS NULL
        AND period_run.completed_at IS NULL
    )
),
aggregated_backfill AS (
  SELECT
    untouched.schedule_id,
    untouched.project_id,
    untouched.frequency,
    min(period_run.period_start) AS period_start,
    max(period_run.period_end) AS period_end,
    array_agg(period_run.id ORDER BY period_run.period_start, period_run.period_end, period_run.id) AS row_ids
  FROM untouched_backfill_groups AS untouched
  INNER JOIN public.report_schedule_period_runs AS period_run
    ON period_run.schedule_id = untouched.schedule_id
   AND period_run.project_id = untouched.project_id
   AND period_run.frequency = untouched.frequency
   AND period_run.run_kind = 'scheduled_backfill'
  GROUP BY untouched.schedule_id, untouched.project_id, untouched.frequency
),
deleted_backfill AS (
  DELETE FROM public.report_schedule_period_runs AS period_run
  USING aggregated_backfill AS aggregated
  WHERE period_run.id = ANY(aggregated.row_ids)
  RETURNING period_run.id
)
INSERT INTO public.report_schedule_period_runs (
  schedule_id,
  project_id,
  frequency,
  period_start,
  period_end,
  run_kind,
  status
)
SELECT
  aggregated.schedule_id,
  aggregated.project_id,
  aggregated.frequency,
  aggregated.period_start,
  aggregated.period_end,
  'scheduled_backfill',
  'pending'
FROM aggregated_backfill AS aggregated;
