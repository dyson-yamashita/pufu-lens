-- Migration: 0024_activitypub_operations
-- Purpose: ActivityPub Step 7 operator audit table for safe retry-exhausted queue actions.

CREATE TABLE IF NOT EXISTS public.activitypub_queue_operator_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_message_id uuid NOT NULL REFERENCES public.activitypub_queue_messages (id) ON DELETE RESTRICT,
  action text NOT NULL,
  previous_status text NOT NULL,
  new_status text NOT NULL,
  previous_attempt_count integer NOT NULL,
  previous_error_code text,
  previous_http_status integer,
  change_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activitypub_queue_operator_actions_action_check
    CHECK (action IN ('requeue', 'discard')),
  CONSTRAINT activitypub_queue_operator_actions_action_transition_check
    CHECK (
      (action = 'requeue' AND previous_status = 'retry_exhausted' AND new_status = 'pending')
      OR (action = 'discard' AND previous_status = 'retry_exhausted' AND new_status = 'permanent_failure')
    ),
  CONSTRAINT activitypub_queue_operator_actions_previous_attempt_count_check
    CHECK (previous_attempt_count >= 0),
  CONSTRAINT activitypub_queue_operator_actions_previous_http_status_check
    CHECK (
      previous_http_status IS NULL
      OR (previous_http_status BETWEEN 100 AND 599)
    ),
  CONSTRAINT activitypub_queue_operator_actions_change_ref_format_check
    CHECK (
      char_length(change_ref) <= 72
      AND change_ref ~ '^(issue|pr|change|incident|ticket)-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    ),
  CONSTRAINT activitypub_queue_operator_actions_previous_error_code_check
    CHECK (
      previous_error_code IS NULL
      OR previous_error_code IN (
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
    )
);

CREATE INDEX IF NOT EXISTS activitypub_queue_operator_actions_message_created_idx
  ON public.activitypub_queue_operator_actions (queue_message_id, created_at DESC);
