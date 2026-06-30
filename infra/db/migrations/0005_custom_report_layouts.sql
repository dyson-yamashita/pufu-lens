-- Migration: 0005_custom_report_layouts
-- Purpose: Add data model for project-scoped custom report templates, image assets, and report runs.
-- Existing DB notes: No backfill is required. Existing reports remain standard reports unless their
-- private JSON later includes an optional custom_layout snapshot.
-- Deploy order:
--   1. Run `pnpm db:migrate`.
--   2. Verify custom_report_templates, custom_report_assets, and report_template_runs exist.
-- Fresh DB sync:
--   - Reflect the final schema in infra/docker/postgres/init.sql.
--   - Add this version to the schema_migrations seed when init.sql includes it.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Layout JSON stores prompts and display configuration only. Do not store raw locators,
--     storage credentials, OAuth tokens, API keys, or unredacted personal data.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.reports'::regclass
      AND conname = 'reports_project_id_id_key'
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_project_id_id_key UNIQUE (project_id, id);
  END IF;
END
$$;

CREATE TABLE public.custom_report_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  object_storage_uri TEXT NOT NULL CHECK (object_storage_uri !~ '(^/|\.\.)'),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/svg+xml')),
  byte_size BIGINT NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, id)
);
CREATE INDEX custom_report_assets_project_status_idx
  ON public.custom_report_assets (project_id, status, created_at DESC);

CREATE TABLE public.custom_report_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  schema_version TEXT NOT NULL DEFAULT 'custom-report-template-v1',
  template_version INTEGER NOT NULL DEFAULT 1 CHECK (template_version >= 1),
  layout JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  UNIQUE (project_id, name)
);
CREATE INDEX custom_report_templates_project_active_idx
  ON public.custom_report_templates (project_id, is_active, updated_at DESC);

CREATE TABLE public.report_template_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  report_id UUID NOT NULL,
  template_id UUID,
  template_version INTEGER NOT NULL CHECK (template_version >= 1),
  template_snapshot_hash TEXT NOT NULL,
  layout_snapshot JSONB NOT NULL,
  judgement_summary JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, report_id),
  FOREIGN KEY (project_id, report_id) REFERENCES public.reports(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, template_id)
    REFERENCES public.custom_report_templates(project_id, id)
    ON DELETE SET NULL (template_id)
);
CREATE INDEX report_template_runs_template_idx
  ON public.report_template_runs (template_id, created_at DESC);

CREATE TRIGGER custom_report_assets_set_updated_at
  BEFORE UPDATE ON public.custom_report_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER custom_report_templates_set_updated_at
  BEFORE UPDATE ON public.custom_report_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
