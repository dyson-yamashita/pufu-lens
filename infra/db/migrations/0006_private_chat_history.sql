-- Migration: 0006_private_chat_history
-- Purpose: Persist private logged-in project chat turns per project/user.
-- Fresh DB sync:
--   - Reflect the final schema in infra/docker/postgres/init.sql.
--   - Add this version to the schema_migrations baseline seed when init.sql includes it.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Do not include real personal data, OAuth tokens, API keys, or secrets.

CREATE TABLE IF NOT EXISTS public.private_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  editing JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS private_chat_messages_project_user_created_idx
ON public.private_chat_messages (project_id, user_id, created_at DESC, id DESC);
