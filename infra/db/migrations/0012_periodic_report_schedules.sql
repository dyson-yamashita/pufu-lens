-- Migration: 0012_periodic_report_schedules
-- Purpose: Add project report schedules, period-run history, and scheduled report metadata.
-- Fresh DB sync:
--   - Reflect the final schema in infra/docker/postgres/init.sql.
--   - Add this version to the schema_migrations seed.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - last_error and skip_reason store only bounded operational summaries, never raw content or secrets.

CREATE TABLE IF NOT EXISTS public.project_report_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL DEFAULT 'none',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  run_time TIME NOT NULL DEFAULT TIME '10:00',
  next_run_at TIMESTAMPTZ,
  last_started_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  worker_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_report_schedules_project_key UNIQUE (project_id),
  CONSTRAINT project_report_schedules_id_project_key UNIQUE (id, project_id),
  CONSTRAINT project_report_schedules_frequency_check
    CHECK (frequency IN ('none', 'weekly', 'monthly', 'annually')),
  CONSTRAINT project_report_schedules_timezone_check CHECK (timezone = 'Asia/Tokyo'),
  CONSTRAINT project_report_schedules_next_run_check CHECK (
    (frequency = 'none' AND next_run_at IS NULL)
    OR (frequency <> 'none' AND next_run_at IS NOT NULL)
  ),
  CONSTRAINT project_report_schedules_retry_count_check CHECK (retry_count >= 0),
  CONSTRAINT project_report_schedules_last_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  CONSTRAINT project_report_schedules_lease_pair_check CHECK (
    (lease_expires_at IS NULL) = (worker_token IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS project_report_schedules_due_idx
  ON public.project_report_schedules (next_run_at, id)
  WHERE frequency <> 'none';

CREATE TABLE IF NOT EXISTS public.report_schedule_period_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL,
  project_id UUID NOT NULL,
  frequency TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  run_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  worker_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  report_id UUID,
  skip_reason TEXT,
  notification_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT report_schedule_period_runs_id_project_frequency_key UNIQUE (id, project_id, frequency),
  CONSTRAINT report_schedule_period_runs_project_period_key
    UNIQUE (project_id, frequency, period_start, period_end),
  CONSTRAINT report_schedule_period_runs_schedule_scope_fkey
    FOREIGN KEY (schedule_id, project_id)
    REFERENCES public.project_report_schedules(id, project_id) ON DELETE CASCADE,
  CONSTRAINT report_schedule_period_runs_frequency_check
    CHECK (frequency IN ('weekly', 'monthly', 'annually')),
  CONSTRAINT report_schedule_period_runs_period_check CHECK (period_start <= period_end),
  CONSTRAINT report_schedule_period_runs_run_kind_check
    CHECK (run_kind IN ('scheduled', 'scheduled_backfill')),
  CONSTRAINT report_schedule_period_runs_status_check CHECK (
    status IN ('pending', 'running', 'succeeded', 'skipped', 'retry_wait', 'retry_exhausted')
  ),
  CONSTRAINT report_schedule_period_runs_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT report_schedule_period_runs_last_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  CONSTRAINT report_schedule_period_runs_skip_reason_check CHECK (
    skip_reason IS NULL OR char_length(skip_reason) BETWEEN 1 AND 1000
  ),
  CONSTRAINT report_schedule_period_runs_skipped_check CHECK (
    status <> 'skipped'
    OR (report_id IS NULL AND skip_reason IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT report_schedule_period_runs_succeeded_check CHECK (
    (status = 'succeeded' AND report_id IS NOT NULL AND completed_at IS NOT NULL)
    OR (status <> 'succeeded' AND report_id IS NULL)
  ),
  CONSTRAINT report_schedule_period_runs_retry_wait_check CHECK (
    status <> 'retry_wait' OR next_attempt_at IS NOT NULL
  ),
  CONSTRAINT report_schedule_period_runs_lease_pair_check CHECK (
    (lease_expires_at IS NULL) = (worker_token IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS report_schedule_period_runs_queue_idx
  ON public.report_schedule_period_runs (period_start, period_end, id)
  WHERE status IN ('pending', 'running', 'retry_wait');

CREATE INDEX IF NOT EXISTS report_schedule_period_runs_project_status_idx
  ON public.report_schedule_period_runs (project_id, status, period_start, id);

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS generation_kind TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS schedule_frequency TEXT,
  ADD COLUMN IF NOT EXISTS previous_scheduled_report_id UUID,
  ADD COLUMN IF NOT EXISTS schedule_period_run_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reports'::regclass
      AND conname = 'reports_generation_kind_check'
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_generation_kind_check
      CHECK (generation_kind IN ('manual', 'scheduled', 'scheduled_backfill'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reports'::regclass
      AND conname = 'reports_project_schedule_frequency_id_key'
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_project_schedule_frequency_id_key
      UNIQUE (project_id, schedule_frequency, id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reports'::regclass
      AND conname = 'reports_schedule_frequency_check'
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_schedule_frequency_check
      CHECK (schedule_frequency IS NULL OR schedule_frequency IN ('weekly', 'monthly', 'annually'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reports'::regclass
      AND conname = 'reports_schedule_metadata_check'
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_schedule_metadata_check CHECK (
        (
          generation_kind = 'manual'
          AND schedule_frequency IS NULL
          AND previous_scheduled_report_id IS NULL
          AND schedule_period_run_id IS NULL
        )
        OR (
          generation_kind IN ('scheduled', 'scheduled_backfill')
          AND schedule_frequency IS NOT NULL
          AND schedule_period_run_id IS NOT NULL
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reports'::regclass
      AND conname = 'reports_previous_scheduled_scope_fkey'
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_previous_scheduled_scope_fkey
      FOREIGN KEY (project_id, schedule_frequency, previous_scheduled_report_id)
      REFERENCES public.reports(project_id, schedule_frequency, id)
      ON DELETE SET NULL (previous_scheduled_report_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reports'::regclass
      AND conname = 'reports_schedule_period_run_scope_fkey'
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_schedule_period_run_scope_fkey
      FOREIGN KEY (schedule_period_run_id, project_id, schedule_frequency)
      REFERENCES public.report_schedule_period_runs(id, project_id, frequency);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reports'::regclass
      AND conname = 'reports_schedule_period_run_key'
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_schedule_period_run_key UNIQUE (schedule_period_run_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reports'::regclass
      AND conname = 'reports_schedule_run_scope_key'
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_schedule_run_scope_key
      UNIQUE (id, schedule_period_run_id, project_id, schedule_frequency);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.report_schedule_period_runs'::regclass
      AND conname = 'report_schedule_period_runs_report_scope_fkey'
  ) THEN
    ALTER TABLE public.report_schedule_period_runs
      ADD CONSTRAINT report_schedule_period_runs_report_scope_fkey
      FOREIGN KEY (report_id, id, project_id, frequency)
      REFERENCES public.reports(id, schedule_period_run_id, project_id, schedule_frequency);
  END IF;
END $$;
