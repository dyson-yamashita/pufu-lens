-- Migration: 0020_activitypub_report_publication_outbox
-- Purpose: ActivityPub Step 4 report publication outbox, dispatcher lease fields, and follow audience timestamps.

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS activitypub_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS activitypub_public_summary text;

ALTER TABLE public.activitypub_activities
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

ALTER TABLE public.activitypub_activities
  DROP CONSTRAINT IF EXISTS activitypub_activities_attempt_count_check;

ALTER TABLE public.activitypub_activities
  ADD CONSTRAINT activitypub_activities_attempt_count_check
  CHECK (attempt_count >= 0) NOT VALID;

ALTER TABLE public.activitypub_queue_messages
  ADD COLUMN IF NOT EXISTS attempt_lease_started_at timestamptz;

ALTER TABLE public.activitypub_follows
  DROP CONSTRAINT IF EXISTS activitypub_follows_accepted_timestamp_check;

ALTER TABLE public.activitypub_follows
  ADD CONSTRAINT activitypub_follows_accepted_timestamp_check
  CHECK (
    (status = 'accepted' AND accepted_at IS NOT NULL AND undone_at IS NULL)
    OR (status = 'undone' AND undone_at IS NOT NULL)
    OR (status IN ('pending', 'rejected') AND accepted_at IS NULL AND undone_at IS NULL)
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS activitypub_activities_outbound_due_idx
  ON public.activitypub_activities (available_at, occurred_at, id)
  WHERE direction = 'outbound' AND processing_status = 'pending';

CREATE INDEX IF NOT EXISTS activitypub_activities_outbound_running_lease_idx
  ON public.activitypub_activities (lease_expires_at, id)
  WHERE direction = 'outbound' AND processing_status = 'running';

CREATE INDEX IF NOT EXISTS activitypub_queue_messages_running_lease_idx
  ON public.activitypub_queue_messages (lease_expires_at, id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS activitypub_queue_messages_outbox_claim_idx
  ON public.activitypub_queue_messages (queue_kind, available_at, created_at, id)
  WHERE status IN ('pending', 'retry_wait');

UPDATE public.activitypub_queue_messages
SET last_error_code = 'unknown_delivery_error'
WHERE last_error_code = 'activitypub_delivery_failed';

UPDATE public.activitypub_activities
SET last_error_code = 'unknown_delivery_error'
WHERE last_error_code = 'activitypub_delivery_failed';

ALTER TABLE public.activitypub_queue_messages
  DROP CONSTRAINT IF EXISTS activitypub_queue_messages_last_error_code_check;

ALTER TABLE public.activitypub_queue_messages
  ADD CONSTRAINT activitypub_queue_messages_last_error_code_check
  CHECK (
    last_error_code IS NULL
    OR last_error_code IN (
      'delivery_timeout',
      'network_error',
      'http_408',
      'http_429',
      'http_5xx',
      'inbox_gone',
      'http_4xx',
      'unknown_delivery_error',
      'lease_lost',
      'activitypub_predecessor_failure',
      'activitypub_materialization_private',
      'activitypub_materialization_disabled',
      'activitypub_materialization_representation',
      'activitypub_materialization_retry_exhausted'
    )
  ) NOT VALID;

ALTER TABLE public.activitypub_activities
  DROP CONSTRAINT IF EXISTS activitypub_activities_last_error_code_check;

ALTER TABLE public.activitypub_activities
  ADD CONSTRAINT activitypub_activities_last_error_code_check
  CHECK (
    last_error_code IS NULL
    OR last_error_code IN (
      'delivery_timeout',
      'network_error',
      'http_408',
      'http_429',
      'http_5xx',
      'inbox_gone',
      'http_4xx',
      'unknown_delivery_error',
      'lease_lost',
      'activitypub_predecessor_failure',
      'activitypub_materialization_private',
      'activitypub_materialization_disabled',
      'activitypub_materialization_representation',
      'activitypub_materialization_retry_exhausted'
    )
  ) NOT VALID;
