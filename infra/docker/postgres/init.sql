CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;

LOAD 'age';
SET search_path = ag_catalog, "$user", public;
ALTER DATABASE pufu_lens SET search_path = ag_catalog, "$user", public;

CREATE TABLE public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'system')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
  name TEXT NOT NULL,
  description TEXT,
  graph_name TEXT NOT NULL UNIQUE CHECK (graph_name ~ '^graph_[a-z0-9_]+$'),
  storage_prefix TEXT NOT NULL UNIQUE CHECK (storage_prefix !~ '(^/|\\.\\.)'),
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.project_members (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE public.oauth_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  provider_account_id TEXT NOT NULL,
  account_email TEXT,
  account_login TEXT,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  access_token_secret TEXT NOT NULL,
  refresh_token_secret TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, provider_account_id),
  UNIQUE (id, user_id)
);

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
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_type, name),
  FOREIGN KEY (connection_id, owner_user_id) REFERENCES public.oauth_connections(id, user_id) ON DELETE CASCADE
);
CREATE INDEX data_sources_project_enabled_idx ON public.data_sources (project_id, enabled);

CREATE TABLE public.raw_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('gmail', 'drive', 'github', 'web')),
  source_id TEXT NOT NULL,
  source_uri TEXT,
  storage_uri TEXT NOT NULL,
  parsed_uri TEXT,
  mime_type TEXT,
  byte_size BIGINT,
  content_hash TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parsed_at TIMESTAMPTZ,
  indexed_at TIMESTAMPTZ,
  ingest_status TEXT NOT NULL DEFAULT 'fetched' CHECK (ingest_status IN ('fetched', 'parsed', 'indexed', 'failed')),
  ingest_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_type, source_id)
);
CREATE INDEX raw_documents_project_status_fetched_idx ON public.raw_documents (project_id, ingest_status, fetched_at DESC);
CREATE INDEX raw_documents_project_source_hash_idx ON public.raw_documents (project_id, source_type, content_hash);

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
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'parsing', 'parsed', 'indexed', 'failed', 'skipped')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, raw_document_id),
  UNIQUE (project_id, data_source_id, target_id)
);
CREATE INDEX ingestion_queue_project_status_idx ON public.ingestion_queue (project_id, status, priority DESC, scheduled_at);

CREATE TABLE public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  raw_document_id UUID NOT NULL REFERENCES public.raw_documents(id) ON DELETE CASCADE,
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
  embedding_model TEXT NOT NULL DEFAULT 'text-embedding-004',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, document_id, chunk_index),
  UNIQUE (project_id, document_id, content_hash)
);
CREATE INDEX document_chunks_embedding_idx ON public.document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX document_chunks_project_document_idx ON public.document_chunks (project_id, document_id);

CREATE TABLE public.actors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL DEFAULT 'person' CHECK (actor_type IN ('person', 'organization', 'bot')),
  display_name TEXT NOT NULL,
  primary_email TEXT,
  primary_login TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  graph_node_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, graph_node_id)
);
CREATE INDEX actors_project_type_idx ON public.actors (project_id, actor_type);

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

INSERT INTO public.users (id, email, name, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'system@pufu-lens.local', 'Pufu Lens System', 'system')
ON CONFLICT (email) DO NOTHING;

INSERT INTO public.projects (id, slug, name, description, graph_name, storage_prefix)
VALUES (
  '00000000-0000-0000-0000-000000000101',
  'local-dev',
  'Local Development',
  'Fixture and CLI smoke test project',
  'graph_local_dev',
  'local-dev'
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
