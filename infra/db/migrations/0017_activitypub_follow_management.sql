-- Migration: 0017_activitypub_follow_management
-- Purpose: Add ActivityPub Step 3 follow pagination indexes and timestamp consistency checks.

CREATE INDEX IF NOT EXISTS activitypub_follows_accepted_collection_idx
  ON public.activitypub_follows (local_actor_id, direction, created_at, id)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS activitypub_follows_outbound_project_list_idx
  ON public.activitypub_follows (local_actor_id, created_at, id)
  WHERE direction = 'outbound';

ALTER TABLE public.activitypub_follows
  DROP CONSTRAINT IF EXISTS activitypub_follows_accepted_timestamp_check;

ALTER TABLE public.activitypub_follows
  ADD CONSTRAINT activitypub_follows_accepted_timestamp_check
  CHECK (
    (status = 'accepted' AND accepted_at IS NOT NULL)
    OR (status <> 'accepted' AND accepted_at IS NULL)
  );

ALTER TABLE public.activitypub_follows
  DROP CONSTRAINT IF EXISTS activitypub_follows_undone_timestamp_check;

ALTER TABLE public.activitypub_follows
  ADD CONSTRAINT activitypub_follows_undone_timestamp_check
  CHECK (
    (status = 'undone' AND undone_at IS NOT NULL)
    OR (status <> 'undone' AND undone_at IS NULL)
  );
