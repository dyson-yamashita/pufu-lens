-- Migration: 0021_activitypub_validate_step4_constraints
-- Purpose: Validate NOT VALID constraints introduced in Step 4.

ALTER TABLE public.activitypub_activities
  VALIDATE CONSTRAINT activitypub_activities_attempt_count_check;

ALTER TABLE public.activitypub_follows
  VALIDATE CONSTRAINT activitypub_follows_accepted_timestamp_check;

ALTER TABLE public.activitypub_queue_messages
  VALIDATE CONSTRAINT activitypub_queue_messages_last_error_code_check;

ALTER TABLE public.activitypub_activities
  VALIDATE CONSTRAINT activitypub_activities_last_error_code_check;
