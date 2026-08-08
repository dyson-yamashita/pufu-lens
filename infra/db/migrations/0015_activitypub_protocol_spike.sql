-- Migration: 0015_activitypub_protocol_spike
-- Purpose: Add Fedify KV and custom queue tables for ActivityPub Step 1 protocol spike.
-- Fresh DB sync:
--   - Add byte-for-byte equivalent definitions to infra/docker/postgres/init.sql.
--   - Add this version to schema_migrations seed in init.sql.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Queue JSON stores redacted outbox metadata only; private JWK material must not be persisted.

CREATE TABLE IF NOT EXISTS public.activitypub_fedify_kv (
  key text[] PRIMARY KEY,
  value jsonb NOT NULL,
  created timestamptz DEFAULT CURRENT_TIMESTAMP,
  ttl interval
);

CREATE TABLE IF NOT EXISTS public.activitypub_queue_messages (
  id uuid PRIMARY KEY,
  dedupe_key text NOT NULL,
  queue_kind text NOT NULL,
  ordering_key text,
  recipient_origin text,
  message_json jsonb NOT NULL,
  status text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  worker_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  last_http_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activitypub_queue_messages_dedupe_key_key UNIQUE (dedupe_key),
  CONSTRAINT activitypub_queue_messages_queue_kind_check
    CHECK (queue_kind IN ('inbox', 'outbox')),
  CONSTRAINT activitypub_queue_messages_status_check
    CHECK (
      status IN (
        'pending',
        'running',
        'retry_wait',
        'succeeded',
        'retry_exhausted',
        'permanent_failure'
      )
    ),
  CONSTRAINT activitypub_queue_messages_attempt_count_check
    CHECK (attempt_count >= 0),
  CONSTRAINT activitypub_queue_messages_lease_pair_check
    CHECK (
      (worker_token IS NULL AND lease_expires_at IS NULL)
      OR (worker_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
  CONSTRAINT activitypub_queue_messages_outbox_ordering_check
    CHECK (queue_kind <> 'outbox' OR (queue_kind = 'outbox' AND ordering_key IS NOT NULL)),
  CONSTRAINT activitypub_queue_messages_outbox_recipient_check
    CHECK (queue_kind <> 'outbox' OR (queue_kind = 'outbox' AND recipient_origin IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS activitypub_queue_messages_due_idx
  ON public.activitypub_queue_messages (available_at, created_at, id)
  WHERE status IN ('pending', 'retry_wait');

CREATE INDEX IF NOT EXISTS activitypub_queue_messages_ordering_origin_idx
  ON public.activitypub_queue_messages (ordering_key, recipient_origin);
