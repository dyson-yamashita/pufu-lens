-- Migration: 0019_activitypub_follow_constraint_validation
-- Purpose: Validate ActivityPub Step 3 follow timestamp CHECK constraints after NOT VALID add.

ALTER TABLE public.activitypub_follows
  VALIDATE CONSTRAINT activitypub_follows_accepted_timestamp_check;

ALTER TABLE public.activitypub_follows
  VALIDATE CONSTRAINT activitypub_follows_undone_timestamp_check;
