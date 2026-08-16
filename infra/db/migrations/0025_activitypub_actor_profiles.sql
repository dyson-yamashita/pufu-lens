-- Migration: 0025_activitypub_actor_profiles
-- Purpose: Add ActivityPub actor profile fields for display name customization, icon URL, and post-generation prompts.
-- Fresh DB sync:
--   - Add byte-for-byte equivalent definitions to infra/docker/postgres/init.sql.
--   - Add this version to schema_migrations seed in init.sql.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - additional_prompt may contain operator instructions; never log prompt content.

ALTER TABLE public.activitypub_actors
  ADD COLUMN IF NOT EXISTS icon_url text,
  ADD COLUMN IF NOT EXISTS additional_prompt text;

ALTER TABLE public.activitypub_actors
  DROP CONSTRAINT IF EXISTS activitypub_actors_icon_url_length_check;

ALTER TABLE public.activitypub_actors
  ADD CONSTRAINT activitypub_actors_icon_url_length_check
    CHECK (icon_url IS NULL OR char_length(icon_url) <= 2048);

ALTER TABLE public.activitypub_actors
  DROP CONSTRAINT IF EXISTS activitypub_actors_additional_prompt_length_check;

ALTER TABLE public.activitypub_actors
  ADD CONSTRAINT activitypub_actors_additional_prompt_length_check
    CHECK (additional_prompt IS NULL OR char_length(additional_prompt) <= 2000);
