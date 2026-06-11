CREATE TABLE IF NOT EXISTS public.oauth_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  provider_account_id TEXT NOT NULL DEFAULT '',
  account_email TEXT,
  account_login TEXT,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  access_token_secret TEXT,
  refresh_token_secret TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, provider),
  UNIQUE (id, user_id)
);

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS provider_account_id TEXT NOT NULL DEFAULT '';

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS account_email TEXT;

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS account_login TEXT;

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS access_token_secret TEXT;

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS refresh_token_secret TEXT;

ALTER TABLE public.oauth_connections
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE public.oauth_connections oc
SET project_id = ds.project_id
FROM public.data_sources ds
WHERE ds.connection_id = oc.id
  AND oc.project_id IS NULL;

UPDATE public.oauth_connections oc
SET user_id = ds.owner_user_id
FROM public.data_sources ds
WHERE ds.connection_id = oc.id
  AND oc.user_id IS NULL;

UPDATE public.oauth_connections
SET provider_account_id = ''
WHERE provider_account_id IS NULL;

UPDATE public.oauth_connections
SET scopes = '{}'
WHERE scopes IS NULL;

UPDATE public.oauth_connections
SET metadata = '{}'
WHERE metadata IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.oauth_connections
    WHERE project_id IS NULL
  ) THEN
    RAISE EXCEPTION 'oauth_connections.project_id is required before applying 0002_project_oauth_connections';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.oauth_connections
    WHERE user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'oauth_connections.user_id is required before applying 0002_project_oauth_connections';
  END IF;
END
$$;

ALTER TABLE public.oauth_connections
  ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE public.oauth_connections
  ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE public.oauth_connections
  ALTER COLUMN provider_account_id SET DEFAULT '';

ALTER TABLE public.oauth_connections
  ALTER COLUMN provider_account_id SET NOT NULL;

ALTER TABLE public.oauth_connections
  ALTER COLUMN scopes SET DEFAULT '{}';

ALTER TABLE public.oauth_connections
  ALTER COLUMN scopes SET NOT NULL;

ALTER TABLE public.oauth_connections
  ALTER COLUMN metadata SET DEFAULT '{}';

ALTER TABLE public.oauth_connections
  ALTER COLUMN metadata SET NOT NULL;

ALTER TABLE public.oauth_connections
  ALTER COLUMN access_token_secret DROP NOT NULL;

ALTER TABLE public.oauth_connections
  DROP CONSTRAINT IF EXISTS oauth_connections_user_id_provider_provider_account_id_key;

DROP INDEX IF EXISTS public.oauth_connections_project_provider_uidx;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'oauth_connections_project_provider_key'
      AND conrelid = 'public.oauth_connections'::regclass
  ) THEN
    ALTER TABLE public.oauth_connections
      ADD CONSTRAINT oauth_connections_project_provider_key UNIQUE (project_id, provider);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'oauth_connections_id_user_id_key'
      AND conrelid = 'public.oauth_connections'::regclass
  ) THEN
    ALTER TABLE public.oauth_connections
      ADD CONSTRAINT oauth_connections_id_user_id_key UNIQUE (id, user_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS oauth_connections_project_id_idx
  ON public.oauth_connections (project_id);
