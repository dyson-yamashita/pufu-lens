-- Migration: 0014_data_source_schedule_default_0600
-- Purpose: Change default daily_time for new data_source_schedules rows from 10:00 to 06:00 Asia/Tokyo.
-- Fresh DB sync:
--   - init.sql daily_time default is 06:00; add this version to schema_migrations seed in init.sql.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Touches only the column default; does not rewrite existing schedule rows.

ALTER TABLE public.data_source_schedules
  ALTER COLUMN daily_time SET DEFAULT TIME '06:00';
