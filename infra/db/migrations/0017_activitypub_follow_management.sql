-- Migration: 0017_activitypub_follow_management
-- Purpose: ActivityPub Step 3 follow timestamp consistency checks.

ALTER TABLE public.activitypub_follows
  ADD CONSTRAINT activitypub_follows_accepted_timestamp_check
  CHECK (
    (status = 'accepted' AND accepted_at IS NOT NULL)
    OR (status <> 'accepted' AND accepted_at IS NULL)
  ) NOT VALID;

ALTER TABLE public.activitypub_follows
  ADD CONSTRAINT activitypub_follows_undone_timestamp_check
  CHECK (
    (status = 'undone' AND undone_at IS NOT NULL)
    OR (status <> 'undone' AND undone_at IS NULL)
  ) NOT VALID;
