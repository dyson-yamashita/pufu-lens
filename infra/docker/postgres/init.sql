CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;
CREATE EXTENSION IF NOT EXISTS pgroonga;

LOAD 'age';
SET search_path = ag_catalog, "$user", public;
ALTER DATABASE pufu_lens SET search_path = ag_catalog, "$user", public;

CREATE TABLE public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.auth_accounts (
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
CREATE INDEX auth_accounts_user_idx ON public.auth_accounts (user_id);

CREATE TABLE public.auth_password_credentials (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
  name TEXT NOT NULL,
  description TEXT,
  graph_name TEXT NOT NULL UNIQUE CHECK (graph_name ~ '^graph_[a-z0-9_]+$'),
  storage_prefix TEXT NOT NULL UNIQUE CHECK (storage_prefix !~ '(^/|\\.\\.)'),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.project_members (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE public.oauth_connections (
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
CREATE INDEX oauth_connections_project_id_idx ON public.oauth_connections (project_id);

CREATE TABLE public.data_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  connection_id UUID,
  source_type TEXT NOT NULL CHECK (source_type IN ('gmail', 'drive', 'github', 'web')),
  name TEXT NOT NULL,
  config JSONB NOT NULL,
  ingest_window JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  sync_cursor JSONB NOT NULL DEFAULT '{}',
  last_checked_at TIMESTAMPTZ,
  last_sync_succeeded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT data_sources_sync_cursor_object_check CHECK (jsonb_typeof(sync_cursor) = 'object'),
  CONSTRAINT data_sources_id_project_key UNIQUE (id, project_id),
  UNIQUE (project_id, source_type, name),
  FOREIGN KEY (connection_id, owner_user_id) REFERENCES public.oauth_connections(id, user_id) ON DELETE CASCADE
);
CREATE INDEX data_sources_project_enabled_idx ON public.data_sources (project_id, enabled);

CREATE TABLE public.data_source_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  data_source_id UUID NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  daily_time TIME NOT NULL DEFAULT TIME '10:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  next_run_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  worker_token TEXT,
  last_started_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT data_source_schedules_data_source_key UNIQUE (data_source_id),
  CONSTRAINT data_source_schedules_project_data_source_key UNIQUE (project_id, data_source_id),
  CONSTRAINT data_source_schedules_timezone_check CHECK (timezone = 'Asia/Tokyo'),
  CONSTRAINT data_source_schedules_retry_count_check CHECK (retry_count >= 0),
  CONSTRAINT data_source_schedules_lease_pair_check CHECK ((lease_expires_at IS NULL) = (worker_token IS NULL)),
  CONSTRAINT data_source_schedules_source_scope_fkey FOREIGN KEY (data_source_id, project_id) REFERENCES public.data_sources(id, project_id) ON DELETE CASCADE
);
CREATE INDEX data_source_schedules_due_idx ON public.data_source_schedules (next_run_at, id) WHERE enabled = true;

CREATE TABLE public.parser_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  data_source_id UUID REFERENCES public.data_sources(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('gmail', 'drive', 'github', 'web')),
  name TEXT NOT NULL,
  active_version_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, data_source_id, source_type, name)
);
CREATE INDEX parser_profiles_project_source_idx ON public.parser_profiles (project_id, source_type);

CREATE TABLE public.parser_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parser_profile_id UUID NOT NULL REFERENCES public.parser_profiles(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  artifact_uri TEXT,
  artifact_hash TEXT NOT NULL,
  contract JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review_requested', 'approved', 'retired')),
  validation_report_uri TEXT,
  approved_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parser_profile_id, version)
);
CREATE INDEX parser_versions_profile_status_idx ON public.parser_versions (parser_profile_id, status);
ALTER TABLE public.parser_profiles
  ADD CONSTRAINT parser_profiles_active_version_fk
  FOREIGN KEY (active_version_id) REFERENCES public.parser_versions(id) ON DELETE SET NULL;

CREATE TABLE public.raw_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('gmail', 'drive', 'github', 'web')),
  source_id TEXT NOT NULL,
  logical_source_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_uri TEXT,
  storage_uri TEXT NOT NULL,
  parsed_uri TEXT,
  mime_type TEXT,
  byte_size BIGINT,
  content_hash TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parsed_at TIMESTAMPTZ,
  indexed_at TIMESTAMPTZ,
  ingest_status TEXT NOT NULL DEFAULT 'fetched' CHECK (ingest_status IN ('fetched', 'held', 'parsed', 'indexed', 'failed')),
  ingest_error TEXT,
  hold_reason TEXT CHECK (hold_reason IN ('parser_approval_required', 'parser_contract_mismatch')),
  parser_profile_id UUID REFERENCES public.parser_profiles(id) ON DELETE SET NULL,
  parser_version_id UUID REFERENCES public.parser_versions(id) ON DELETE SET NULL,
  parser_artifact_hash TEXT,
  parsed_schema_version INTEGER,
  sanitized_sample_uri TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_type, source_id),
  CONSTRAINT raw_documents_project_source_logical_version_key
    UNIQUE (project_id, source_type, logical_source_id, source_version)
);
CREATE INDEX raw_documents_project_status_fetched_idx ON public.raw_documents (project_id, ingest_status, fetched_at DESC);
CREATE INDEX raw_documents_project_source_hash_idx ON public.raw_documents (project_id, source_type, content_hash);
CREATE INDEX raw_documents_project_source_logical_latest_idx
  ON public.raw_documents (project_id, source_type, logical_source_id, fetched_at DESC);

CREATE TABLE public.raw_document_data_sources (
  raw_document_id UUID NOT NULL REFERENCES public.raw_documents(id) ON DELETE CASCADE,
  data_source_id UUID NOT NULL REFERENCES public.data_sources(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  match_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (raw_document_id, data_source_id)
);
CREATE INDEX raw_document_data_sources_project_source_idx ON public.raw_document_data_sources (project_id, data_source_id);
CREATE INDEX raw_document_data_sources_project_raw_idx ON public.raw_document_data_sources (project_id, raw_document_id);

CREATE TABLE public.ingestion_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  data_source_id UUID NOT NULL REFERENCES public.data_sources(id) ON DELETE CASCADE,
  raw_document_id UUID NOT NULL REFERENCES public.raw_documents(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  target_uri TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'parsing', 'parsed', 'indexed', 'failed', 'held', 'skipped')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  lease_expires_at TIMESTAMPTZ,
  hold_reason TEXT CHECK (hold_reason IN ('parser_approval_required', 'parser_contract_mismatch')),
  parser_profile_id UUID REFERENCES public.parser_profiles(id) ON DELETE SET NULL,
  parser_version_id UUID REFERENCES public.parser_versions(id) ON DELETE SET NULL,
  sanitized_sample_uri TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, raw_document_id),
  UNIQUE (project_id, data_source_id, target_id)
);
CREATE INDEX ingestion_queue_project_status_idx ON public.ingestion_queue (project_id, status, priority DESC, scheduled_at);
CREATE INDEX ingestion_queue_project_lease_idx
  ON public.ingestion_queue (project_id, status, lease_expires_at)
  WHERE status = 'parsing';

CREATE TABLE public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  raw_document_id UUID NOT NULL REFERENCES public.raw_documents(id) ON DELETE CASCADE,
  logical_source_id TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('email', 'drive_doc', 'issue', 'pull_request', 'web_page')),
  title TEXT,
  summary TEXT,
  canonical_uri TEXT,
  occurred_at TIMESTAMPTZ,
  graph_node_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (raw_document_id),
  CONSTRAINT documents_project_doc_type_logical_source_key
    UNIQUE (project_id, doc_type, logical_source_id),
  UNIQUE (project_id, doc_type, graph_node_id)
);
CREATE INDEX documents_project_type_occurred_idx ON public.documents (project_id, doc_type, occurred_at DESC);

CREATE TABLE public.document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding vector(1536),
  embedding_model TEXT NOT NULL DEFAULT 'gemini-embedding-2',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, document_id, chunk_index),
  UNIQUE (project_id, document_id, content_hash)
);
CREATE INDEX document_chunks_embedding_idx ON public.document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX document_chunks_project_document_idx ON public.document_chunks (project_id, document_id);
CREATE INDEX document_chunks_content_pgroonga_idx ON public.document_chunks USING pgroonga (content);

CREATE TABLE public.document_chunk_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  raw_document_id UUID NOT NULL REFERENCES public.raw_documents(id) ON DELETE CASCADE,
  previous_chunk_id UUID NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding vector(1536),
  embedding_model TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archive_reason TEXT NOT NULL DEFAULT 'document_updated' CHECK (
    archive_reason IN (
      'chunk_config_changed',
      'document_updated',
      'embedding_model_changed',
      'manual_reindex',
      'parser_changed'
    )
  ),
  superseded_by_raw_document_id UUID REFERENCES public.raw_documents(id) ON DELETE SET NULL,
  superseded_by_content_hash TEXT
);
CREATE INDEX document_chunk_history_project_document_idx ON public.document_chunk_history (
  project_id,
  document_id,
  archived_at DESC
);
CREATE INDEX document_chunk_history_project_raw_idx ON public.document_chunk_history (
  project_id,
  raw_document_id
);

CREATE TABLE public.actors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL DEFAULT 'person' CHECK (actor_type IN ('person', 'organization', 'bot')),
  display_name TEXT NOT NULL,
  primary_email TEXT,
  primary_login TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  graph_node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'disabled')),
  merged_into_actor_id UUID,
  disabled_at TIMESTAMPTZ,
  disabled_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  disabled_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, graph_node_id),
  UNIQUE (project_id, id),
  CONSTRAINT actors_merged_into_not_self_check
    CHECK (merged_into_actor_id IS NULL OR merged_into_actor_id <> id),
  CONSTRAINT actors_merged_into_same_project_fk
    FOREIGN KEY (project_id, merged_into_actor_id)
    REFERENCES public.actors (project_id, id)
);
CREATE INDEX actors_project_type_idx ON public.actors (project_id, actor_type);
CREATE INDEX actors_project_status_idx ON public.actors (project_id, status);
CREATE INDEX actors_project_merged_into_idx ON public.actors (project_id, merged_into_actor_id);

CREATE TABLE public.actor_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES public.actors(id) ON DELETE CASCADE,
  alias_type TEXT NOT NULL CHECK (alias_type IN ('email', 'github_login', 'display_name', 'slack_id', 'domain')),
  alias_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, alias_type, alias_value)
);
CREATE INDEX actor_aliases_project_actor_idx ON public.actor_aliases (project_id, actor_id);

CREATE TABLE public.email_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  quote_index INTEGER NOT NULL CHECK (quote_index >= 0),
  quoted_message_id TEXT,
  prev_quote_id UUID REFERENCES public.email_quotes(id) ON DELETE SET NULL,
  sender_alias TEXT,
  sender_actor_id UUID REFERENCES public.actors(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, document_id, quote_index)
);
CREATE INDEX email_quotes_project_document_idx ON public.email_quotes (project_id, document_id, quote_index);

CREATE TABLE public.actor_merge_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  primary_actor_id UUID NOT NULL,
  secondary_actor_id UUID NOT NULL,
  decision_type TEXT NOT NULL CHECK (decision_type IN ('merge', 'reject')),
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (primary_actor_id <> secondary_actor_id),
  CONSTRAINT actor_merge_decisions_primary_same_project_fk
    FOREIGN KEY (project_id, primary_actor_id)
    REFERENCES public.actors (project_id, id),
  CONSTRAINT actor_merge_decisions_secondary_same_project_fk
    FOREIGN KEY (project_id, secondary_actor_id)
    REFERENCES public.actors (project_id, id)
);
CREATE INDEX actor_merge_decisions_project_primary_idx
  ON public.actor_merge_decisions (project_id, primary_actor_id, created_at DESC);
CREATE INDEX actor_merge_decisions_project_secondary_idx
  ON public.actor_merge_decisions (project_id, secondary_actor_id, created_at DESC);
CREATE UNIQUE INDEX actor_merge_decisions_project_pair_type_idx
  ON public.actor_merge_decisions (
    project_id,
    decision_type,
    LEAST(primary_actor_id, secondary_actor_id),
    GREATEST(primary_actor_id, secondary_actor_id)
  );

CREATE TABLE public.project_report_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL DEFAULT 'none',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  run_time TIME NOT NULL DEFAULT TIME '10:00',
  next_run_at TIMESTAMPTZ,
  last_started_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  worker_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_report_schedules_project_key UNIQUE (project_id),
  CONSTRAINT project_report_schedules_id_project_key UNIQUE (id, project_id),
  CONSTRAINT project_report_schedules_frequency_check
    CHECK (frequency IN ('none', 'weekly', 'monthly', 'annually')),
  CONSTRAINT project_report_schedules_timezone_check CHECK (timezone = 'Asia/Tokyo'),
  CONSTRAINT project_report_schedules_next_run_check CHECK (
    (frequency = 'none' AND next_run_at IS NULL)
    OR (frequency <> 'none' AND next_run_at IS NOT NULL)
  ),
  CONSTRAINT project_report_schedules_retry_count_check CHECK (retry_count >= 0),
  CONSTRAINT project_report_schedules_last_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  CONSTRAINT project_report_schedules_lease_pair_check CHECK (
    (lease_expires_at IS NULL) = (worker_token IS NULL)
  )
);
CREATE INDEX project_report_schedules_due_idx
  ON public.project_report_schedules (next_run_at, id)
  WHERE frequency <> 'none';

CREATE TABLE public.report_schedule_period_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL,
  project_id UUID NOT NULL,
  frequency TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  run_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  worker_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  report_id UUID,
  skip_reason TEXT,
  notification_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT report_schedule_period_runs_id_project_frequency_key UNIQUE (id, project_id, frequency),
  CONSTRAINT report_schedule_period_runs_project_period_key
    UNIQUE (project_id, frequency, period_start, period_end),
  CONSTRAINT report_schedule_period_runs_schedule_scope_fkey
    FOREIGN KEY (schedule_id, project_id)
    REFERENCES public.project_report_schedules(id, project_id) ON DELETE CASCADE,
  CONSTRAINT report_schedule_period_runs_frequency_check
    CHECK (frequency IN ('weekly', 'monthly', 'annually')),
  CONSTRAINT report_schedule_period_runs_period_check CHECK (period_start <= period_end),
  CONSTRAINT report_schedule_period_runs_run_kind_check
    CHECK (run_kind IN ('scheduled', 'scheduled_backfill')),
  CONSTRAINT report_schedule_period_runs_status_check CHECK (
    status IN ('pending', 'running', 'succeeded', 'skipped', 'retry_wait', 'retry_exhausted')
  ),
  CONSTRAINT report_schedule_period_runs_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT report_schedule_period_runs_last_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  CONSTRAINT report_schedule_period_runs_skip_reason_check CHECK (
    skip_reason IS NULL OR char_length(skip_reason) BETWEEN 1 AND 1000
  ),
  CONSTRAINT report_schedule_period_runs_skipped_check CHECK (
    status <> 'skipped'
    OR (report_id IS NULL AND skip_reason IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT report_schedule_period_runs_succeeded_check CHECK (
    (status = 'succeeded' AND report_id IS NOT NULL AND completed_at IS NOT NULL)
    OR (status <> 'succeeded' AND report_id IS NULL)
  ),
  CONSTRAINT report_schedule_period_runs_retry_wait_check CHECK (
    status <> 'retry_wait' OR next_attempt_at IS NOT NULL
  ),
  CONSTRAINT report_schedule_period_runs_lease_pair_check CHECK (
    (lease_expires_at IS NULL) = (worker_token IS NULL)
  )
);
CREATE INDEX report_schedule_period_runs_queue_idx
  ON public.report_schedule_period_runs (period_start, period_end, id)
  WHERE status IN ('pending', 'running', 'retry_wait');
CREATE INDEX report_schedule_period_runs_project_status_idx
  ON public.report_schedule_period_runs (project_id, status, period_start, id);

CREATE TABLE public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT,
  storage_uri TEXT NOT NULL,
  schema_version TEXT NOT NULL DEFAULT 'v1',
  period DATERANGE,
  is_public BOOLEAN NOT NULL DEFAULT false,
  generated_by TEXT,
  generation_kind TEXT NOT NULL DEFAULT 'manual',
  schedule_frequency TEXT,
  previous_scheduled_report_id UUID,
  schedule_period_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reports_project_id_id_key UNIQUE (project_id, id),
  CONSTRAINT reports_generation_kind_check
    CHECK (generation_kind IN ('manual', 'scheduled', 'scheduled_backfill')),
  CONSTRAINT reports_schedule_frequency_check
    CHECK (schedule_frequency IS NULL OR schedule_frequency IN ('weekly', 'monthly', 'annually')),
  CONSTRAINT reports_schedule_metadata_check CHECK (
    (
      generation_kind = 'manual'
      AND schedule_frequency IS NULL
      AND previous_scheduled_report_id IS NULL
      AND schedule_period_run_id IS NULL
    )
    OR (
      generation_kind IN ('scheduled', 'scheduled_backfill')
      AND schedule_frequency IS NOT NULL
      AND schedule_period_run_id IS NOT NULL
    )
  ),
  CONSTRAINT reports_project_schedule_frequency_id_key
    UNIQUE (project_id, schedule_frequency, id),
  CONSTRAINT reports_previous_scheduled_scope_fkey
    FOREIGN KEY (project_id, schedule_frequency, previous_scheduled_report_id)
    REFERENCES public.reports(project_id, schedule_frequency, id)
    ON DELETE SET NULL (previous_scheduled_report_id),
  CONSTRAINT reports_schedule_period_run_scope_fkey
    FOREIGN KEY (schedule_period_run_id, project_id, schedule_frequency)
    REFERENCES public.report_schedule_period_runs(id, project_id, frequency),
  CONSTRAINT reports_schedule_period_run_key UNIQUE (schedule_period_run_id),
  CONSTRAINT reports_schedule_run_scope_key
    UNIQUE (id, schedule_period_run_id, project_id, schedule_frequency)
);
CREATE INDEX reports_project_created_idx ON public.reports (project_id, created_at DESC);

ALTER TABLE public.report_schedule_period_runs
  ADD CONSTRAINT report_schedule_period_runs_report_scope_fkey
  FOREIGN KEY (report_id, id, project_id, frequency)
  REFERENCES public.reports(id, schedule_period_run_id, project_id, schedule_frequency);

CREATE TABLE public.custom_report_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  object_storage_uri TEXT NOT NULL CHECK (object_storage_uri !~ '(^/|[.][.])'),
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

CREATE TABLE public.report_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  report_id UUID NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, report_id, chunk_index),
  FOREIGN KEY (project_id, report_id) REFERENCES public.reports(project_id, id) ON DELETE CASCADE
);
CREATE INDEX report_chunks_embedding_idx ON public.report_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX report_chunks_project_report_idx ON public.report_chunks (project_id, report_id);

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

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER oauth_connections_set_updated_at
  BEFORE UPDATE ON public.oauth_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER data_sources_set_updated_at
  BEFORE UPDATE ON public.data_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER parser_profiles_set_updated_at
  BEFORE UPDATE ON public.parser_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER parser_versions_set_updated_at
  BEFORE UPDATE ON public.parser_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER raw_documents_set_updated_at
  BEFORE UPDATE ON public.raw_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER ingestion_queue_set_updated_at
  BEFORE UPDATE ON public.ingestion_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER documents_set_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER actors_set_updated_at
  BEFORE UPDATE ON public.actors
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER custom_report_assets_set_updated_at
  BEFORE UPDATE ON public.custom_report_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER custom_report_templates_set_updated_at
  BEFORE UPDATE ON public.custom_report_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.users (id, email, name, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'system@pufu-lens.local', 'Pufu Lens System', 'member')
ON CONFLICT (email) DO NOTHING;

INSERT INTO public.projects (id, slug, name, description, graph_name, storage_prefix, visibility)
VALUES (
  '00000000-0000-0000-0000-000000000101',
  'local-dev',
  'Local Development',
  'Fixture and CLI smoke test project',
  'graph_local_dev',
  'local-dev',
  'private'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.project_members (project_id, user_id, role)
VALUES (
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000001',
  'admin'
)
ON CONFLICT (project_id, user_id) DO NOTHING;

SELECT create_graph('graph_local_dev')
WHERE NOT EXISTS (
  SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'graph_local_dev'
);

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

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.schema_migrations (version)
VALUES
  ('0001_auth_login'),
  ('0002_project_oauth_connections'),
  ('0003_actor_merge_decisions'),
  ('0004_pgroonga_hybrid_search'),
  ('0005_custom_report_layouts'),
  ('0006_private_chat_history'),
  ('0007_normalize_private_chat_editing'),
  ('0008_normalize_private_chat_history_json_arrays'),
  ('0009_normalize_jsonb_string_storage'),
  ('0010_source_version_model'),
  ('0011_data_source_schedules'),
  ('0012_periodic_report_schedules')
ON CONFLICT (version) DO NOTHING;
