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

UPDATE public.oauth_connections
SET provider_account_id = ''
WHERE provider_account_id IS NULL;

UPDATE public.oauth_connections
SET scopes = '{}'
WHERE scopes IS NULL;

UPDATE public.oauth_connections
SET metadata = '{}'
WHERE metadata IS NULL;

CREATE TEMP TABLE IF NOT EXISTS connection_migration_map (
  old_id UUID NOT NULL,
  project_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  new_id UUID NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (old_id, project_id)
) ON COMMIT DROP;

TRUNCATE connection_migration_map;

INSERT INTO connection_migration_map (old_id, project_id, owner_user_id)
SELECT DISTINCT ON (ds.connection_id, ds.project_id)
  ds.connection_id,
  ds.project_id,
  ds.owner_user_id
FROM public.data_sources ds
JOIN public.oauth_connections oc ON oc.id = ds.connection_id
WHERE ds.connection_id IS NOT NULL
  AND (
    oc.project_id IS DISTINCT FROM ds.project_id
    OR 1 < (
      SELECT count(DISTINCT ds_count.project_id)
      FROM public.data_sources ds_count
      WHERE ds_count.connection_id = ds.connection_id
    )
  )
ORDER BY ds.connection_id, ds.project_id, ds.created_at, ds.id;

INSERT INTO public.oauth_connections (
  id,
  project_id,
  user_id,
  provider,
  provider_account_id,
  account_email,
  account_login,
  scopes,
  metadata,
  access_token_secret,
  refresh_token_secret,
  expires_at,
  created_at,
  updated_at
)
SELECT
  m.new_id,
  m.project_id,
  COALESCE(oc.user_id, m.owner_user_id),
  oc.provider,
  oc.provider_account_id,
  oc.account_email,
  oc.account_login,
  oc.scopes,
  oc.metadata,
  oc.access_token_secret,
  oc.refresh_token_secret,
  oc.expires_at,
  oc.created_at,
  oc.updated_at
FROM connection_migration_map m
JOIN public.oauth_connections oc ON oc.id = m.old_id
ON CONFLICT (id) DO NOTHING;

UPDATE public.data_sources ds
SET connection_id = m.new_id
FROM connection_migration_map m
WHERE ds.connection_id = m.old_id
  AND ds.project_id = m.project_id;

DELETE FROM public.oauth_connections oc
USING (
  SELECT DISTINCT old_id
  FROM connection_migration_map
) migrated
WHERE oc.id = migrated.old_id
  AND NOT EXISTS (
    SELECT 1
    FROM public.data_sources ds
    WHERE ds.connection_id = oc.id
  );

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

UPDATE public.oauth_connections oc
SET project_id = (
  SELECT pm.project_id
  FROM public.project_members pm
  WHERE pm.user_id = oc.user_id
  ORDER BY pm.created_at, pm.project_id
  LIMIT 1
)
WHERE oc.project_id IS NULL
  AND oc.user_id IS NOT NULL;

DELETE FROM public.oauth_connections
WHERE project_id IS NULL
   OR user_id IS NULL;

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
    WHERE conname = 'oauth_connections_project_id_provider_key'
      AND conrelid = 'public.oauth_connections'::regclass
  ) THEN
    ALTER TABLE public.oauth_connections
      ADD CONSTRAINT oauth_connections_project_id_provider_key UNIQUE (project_id, provider);
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
