-- Migration: 0011_data_source_schedules
-- Purpose: Add daily schedules for enabled GitHub, Drive, and Gmail data sources.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.data_sources'::regclass
      AND conname = 'data_sources_id_project_key'
  ) THEN
    ALTER TABLE public.data_sources
      ADD CONSTRAINT data_sources_id_project_key UNIQUE (id, project_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.data_source_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  data_source_id UUID NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  daily_time TIME NOT NULL DEFAULT TIME '10:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  next_run_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  worker_token TEXT,
  last_started_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT data_source_schedules_data_source_key UNIQUE (data_source_id),
  CONSTRAINT data_source_schedules_project_data_source_key UNIQUE (project_id, data_source_id),
  CONSTRAINT data_source_schedules_timezone_check CHECK (timezone = 'Asia/Tokyo'),
  CONSTRAINT data_source_schedules_retry_count_check CHECK (retry_count >= 0),
  CONSTRAINT data_source_schedules_lease_pair_check CHECK (
    (lease_expires_at IS NULL) = (worker_token IS NULL)
  ),
  CONSTRAINT data_source_schedules_source_scope_fkey
    FOREIGN KEY (data_source_id, project_id)
    REFERENCES public.data_sources(id, project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS data_source_schedules_due_idx
  ON public.data_source_schedules (next_run_at, id)
  WHERE enabled = true;

INSERT INTO public.data_source_schedules (
  project_id,
  data_source_id,
  enabled,
  daily_time,
  timezone,
  next_run_at
)
SELECT
  source.project_id,
  source.id,
  true,
  TIME '10:00',
  'Asia/Tokyo',
  (
    CASE
      WHEN (now() AT TIME ZONE 'Asia/Tokyo')::time < TIME '10:00'
        THEN (now() AT TIME ZONE 'Asia/Tokyo')::date
      ELSE (now() AT TIME ZONE 'Asia/Tokyo')::date + 1
    END + TIME '10:00'
  ) AT TIME ZONE 'Asia/Tokyo'
FROM public.data_sources AS source
WHERE source.enabled = true
  AND source.source_type IN ('github', 'drive', 'gmail')
ON CONFLICT (data_source_id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.data_source_schedules AS schedule
    JOIN public.data_sources AS source ON source.id = schedule.data_source_id
    WHERE source.project_id <> schedule.project_id
       OR source.source_type NOT IN ('github', 'drive', 'gmail')
  ) THEN
    RAISE EXCEPTION 'invalid data source schedule scope detected';
  END IF;
END $$;
