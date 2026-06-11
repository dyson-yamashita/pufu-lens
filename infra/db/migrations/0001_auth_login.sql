ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_role_check;

UPDATE public.users
SET role = 'member'
WHERE role IN ('user', 'system')
   OR role IS NULL;

ALTER TABLE public.users
  ALTER COLUMN role SET DEFAULT 'member';

ALTER TABLE public.users
  ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'member'));

ALTER TABLE public.project_members
  DROP CONSTRAINT IF EXISTS project_members_role_check;

UPDATE public.project_members
SET role = 'member'
WHERE role IN ('editor', 'viewer')
   OR role IS NULL;

ALTER TABLE public.project_members
  ALTER COLUMN role SET DEFAULT 'member';

ALTER TABLE public.project_members
  ADD CONSTRAINT project_members_role_check CHECK (role IN ('admin', 'member'));

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';

ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_visibility_check;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_visibility_check CHECK (visibility IN ('private', 'public'));

CREATE TABLE IF NOT EXISTS public.auth_accounts (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  provider_account_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_account_id),
  UNIQUE (provider, user_id)
);

CREATE INDEX IF NOT EXISTS auth_accounts_user_idx
  ON public.auth_accounts (user_id);

CREATE TABLE IF NOT EXISTS public.auth_password_credentials (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
