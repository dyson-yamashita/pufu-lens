-- Migration: 0016_activitypub_actor_endpoints
-- Purpose: Add ActivityPub Step 2 actor, follow, activity, and federated report tables.
-- Fresh DB sync:
--   - Add byte-for-byte equivalent definitions to infra/docker/postgres/init.sql.
--   - Add this version to schema_migrations seed in init.sql.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Actor private keys are stored encrypted; never log PEM, JWK, or ciphertext.

CREATE TABLE IF NOT EXISTS public.activitypub_instance_config (
  id integer PRIMARY KEY,
  object_representation text NOT NULL,
  representation_locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activitypub_instance_config_singleton_id_check CHECK (id = 1),
  CONSTRAINT activitypub_instance_config_object_representation_check
    CHECK (object_representation IN ('article', 'note'))
);

INSERT INTO public.activitypub_instance_config (id, object_representation)
VALUES (1, 'article')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.activitypub_guard_instance_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'activitypub_instance_config row cannot be deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.representation_locked_at IS NOT NULL THEN
      IF NEW.object_representation IS DISTINCT FROM OLD.object_representation THEN
        RAISE EXCEPTION 'activitypub_instance_config object_representation cannot change after lock';
      END IF;
      IF NEW.representation_locked_at IS NULL THEN
        RAISE EXCEPTION 'activitypub_instance_config representation_locked_at cannot be unlocked';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER activitypub_instance_config_guard
  BEFORE UPDATE OR DELETE ON public.activitypub_instance_config
  FOR EACH ROW
  EXECUTE FUNCTION public.activitypub_guard_instance_config();

CREATE TABLE IF NOT EXISTS public.activitypub_actors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  preferred_username text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  public_key_pem text NOT NULL,
  encrypted_private_key jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activitypub_actors_kind_check CHECK (kind IN ('project', 'aggregate')),
  CONSTRAINT activitypub_actors_kind_project_consistency_check
    CHECK (
      (kind = 'aggregate' AND project_id IS NULL)
      OR (kind = 'project' AND project_id IS NOT NULL)
    ),
  CONSTRAINT activitypub_actors_aggregate_username_check
    CHECK (kind <> 'aggregate' OR preferred_username = 'all'),
  CONSTRAINT activitypub_actors_project_username_check
    CHECK (kind <> 'project' OR preferred_username <> 'all'),
  CONSTRAINT activitypub_actors_preferred_username_syntax_check
    CHECK (preferred_username ~ '^[a-z0-9][a-z0-9._-]*[a-z0-9]$'),
  CONSTRAINT activitypub_actors_encrypted_private_key_object_check
    CHECK (jsonb_typeof(encrypted_private_key) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS activitypub_actors_preferred_username_key
  ON public.activitypub_actors (preferred_username);

CREATE UNIQUE INDEX IF NOT EXISTS activitypub_actors_aggregate_unique_idx
  ON public.activitypub_actors (kind)
  WHERE kind = 'aggregate';

CREATE UNIQUE INDEX IF NOT EXISTS activitypub_actors_project_id_key
  ON public.activitypub_actors (project_id)
  WHERE kind = 'project';

CREATE TABLE IF NOT EXISTS public.activitypub_follows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction text NOT NULL,
  local_actor_id uuid NOT NULL REFERENCES public.activitypub_actors(id) ON DELETE CASCADE,
  remote_actor_uri text NOT NULL,
  remote_inbox_uri text NOT NULL,
  remote_shared_inbox_uri text,
  follow_activity_uri text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  undone_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activitypub_follows_direction_check CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT activitypub_follows_status_check
    CHECK (status IN ('pending', 'accepted', 'rejected', 'undone')),
  CONSTRAINT activitypub_follows_direction_local_remote_key
    UNIQUE (direction, local_actor_id, remote_actor_uri)
);

CREATE TABLE IF NOT EXISTS public.activitypub_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_uri text NOT NULL,
  object_uri text,
  activity_type text NOT NULL,
  actor_uri text NOT NULL,
  local_actor_id uuid REFERENCES public.activitypub_actors(id) ON DELETE SET NULL,
  direction text NOT NULL,
  payload_json jsonb NOT NULL,
  processing_status text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  worker_token uuid,
  lease_expires_at timestamptz,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT activitypub_activities_activity_uri_key UNIQUE (activity_uri),
  CONSTRAINT activitypub_activities_direction_check CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT activitypub_activities_processing_status_check
    CHECK (processing_status IN ('pending', 'running', 'processed', 'failed')),
  CONSTRAINT activitypub_activities_payload_json_object_check
    CHECK (jsonb_typeof(payload_json) = 'object'),
  CONSTRAINT activitypub_activities_lease_pair_check
    CHECK (
      (worker_token IS NULL AND lease_expires_at IS NULL)
      OR (worker_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
  CONSTRAINT activitypub_activities_lease_available_check
    CHECK (lease_expires_at IS NULL OR lease_expires_at >= available_at),
  CONSTRAINT activitypub_activities_outbound_local_actor_check
    CHECK (direction <> 'outbound' OR local_actor_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION public.activitypub_lock_representation_on_first_outbound()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  existing_outbound_count integer;
BEGIN
  IF NEW.direction = 'outbound' THEN
    SELECT COUNT(*)::integer
    INTO existing_outbound_count
    FROM public.activitypub_activities
    WHERE direction = 'outbound';

    IF existing_outbound_count = 0 THEN
      IF NOT EXISTS (SELECT 1 FROM public.activitypub_instance_config WHERE id = 1) THEN
        RAISE EXCEPTION 'activitypub_instance_config singleton is missing';
      END IF;

      UPDATE public.activitypub_instance_config
      SET representation_locked_at = now(),
          updated_at = now()
      WHERE id = 1
        AND representation_locked_at IS NULL;

      IF NOT FOUND THEN
        IF NOT EXISTS (
          SELECT 1
          FROM public.activitypub_instance_config
          WHERE id = 1
            AND representation_locked_at IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'activitypub_instance_config singleton is missing';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER activitypub_activities_first_outbound_lock
  BEFORE INSERT ON public.activitypub_activities
  FOR EACH ROW
  EXECUTE FUNCTION public.activitypub_lock_representation_on_first_outbound();

ALTER TABLE public.activitypub_queue_messages
  ADD CONSTRAINT activitypub_queue_messages_message_json_object_check
  CHECK (jsonb_typeof(message_json) = 'object');

CREATE TABLE IF NOT EXISTS public.federated_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_follow_id uuid NOT NULL REFERENCES public.activitypub_follows(id) ON DELETE CASCADE,
  remote_object_uri text NOT NULL,
  remote_activity_uri text NOT NULL,
  remote_actor_uri text NOT NULL,
  object_type text NOT NULL,
  title text NOT NULL,
  summary_html_sanitized text NOT NULL DEFAULT '',
  original_url text NOT NULL,
  published_at timestamptz,
  remote_updated_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT federated_reports_object_type_check CHECK (object_type IN ('article', 'note')),
  CONSTRAINT federated_reports_project_remote_object_key UNIQUE (project_id, remote_object_uri)
);
