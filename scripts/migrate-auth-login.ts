import postgres from 'postgres';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`
      ALTER TABLE public.users
      DROP CONSTRAINT IF EXISTS users_role_check
    `;
    await sql`
      UPDATE public.users
      SET role = 'member'
      WHERE role IN ('user', 'system')
         OR role IS NULL
    `;
    await sql`
      ALTER TABLE public.users
      ALTER COLUMN role SET DEFAULT 'member'
    `;
    await sql`
      ALTER TABLE public.users
      ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'member'))
    `;
    await sql`
      ALTER TABLE public.project_members
      DROP CONSTRAINT IF EXISTS project_members_role_check
    `;
    await sql`
      UPDATE public.project_members
      SET role = 'member'
      WHERE role IN ('editor', 'viewer')
         OR role IS NULL
    `;
    await sql`
      ALTER TABLE public.project_members
      ALTER COLUMN role SET DEFAULT 'member'
    `;
    await sql`
      ALTER TABLE public.project_members
      ADD CONSTRAINT project_members_role_check CHECK (role IN ('admin', 'member'))
    `;
    await sql`
      ALTER TABLE public.projects
      ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
    `;
    await sql`
      ALTER TABLE public.projects
      DROP CONSTRAINT IF EXISTS projects_visibility_check
    `;
    await sql`
      ALTER TABLE public.projects
      ADD CONSTRAINT projects_visibility_check CHECK (visibility IN ('private', 'public'))
    `;
    await sql`
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
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS auth_accounts_user_idx
      ON public.auth_accounts (user_id)
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS public.auth_password_credentials (
        user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS public.oauth_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      ALTER TABLE public.oauth_connections
      ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE
    `;
    await sql`
      ALTER TABLE public.oauth_connections
      ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE
    `;
    await sql`
      ALTER TABLE public.oauth_connections
      ADD COLUMN IF NOT EXISTS account_email TEXT
    `;
    await sql`
      ALTER TABLE public.oauth_connections
      ADD COLUMN IF NOT EXISTS account_login TEXT
    `;
    await sql`
      ALTER TABLE public.oauth_connections
      ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT '{}'
    `;
    await sql`
      ALTER TABLE public.oauth_connections
      ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'
    `;
    await sql`
      ALTER TABLE public.oauth_connections
      ADD COLUMN IF NOT EXISTS access_token_secret TEXT
    `;
    await sql`
      ALTER TABLE public.oauth_connections
      ALTER COLUMN access_token_secret DROP NOT NULL
    `;
    await sql`
      ALTER TABLE public.oauth_connections
      ADD COLUMN IF NOT EXISTS refresh_token_secret TEXT
    `;
    await sql`
      ALTER TABLE public.oauth_connections
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS oauth_connections_project_id_idx
      ON public.oauth_connections (project_id)
    `;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS oauth_connections_project_provider_uidx
      ON public.oauth_connections (project_id, provider)
      WHERE project_id IS NOT NULL
    `;
    await sql`
      ALTER TABLE public.oauth_connections
      DROP CONSTRAINT IF EXISTS oauth_connections_user_id_provider_provider_account_id_key
    `;
  } finally {
    await sql.end();
  }
}

await main();
console.log('auth login migration completed');
