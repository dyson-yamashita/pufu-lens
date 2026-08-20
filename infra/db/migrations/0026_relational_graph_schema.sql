-- Migration: 0026_relational_graph_schema
-- Purpose: Add additive relational graph_nodes / graph_edges tables for Plan 018 Step 2A.
-- Fresh DB sync:
--   - Add byte-for-byte equivalent definitions to infra/docker/postgres/init.sql.
--   - Add this version to schema_migrations seed in init.sql.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - properties JSONB may hold document metadata; never log node_key endpoints or properties content.

CREATE TABLE IF NOT EXISTS public.graph_nodes (
  project_id UUID NOT NULL,
  node_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  subtype TEXT,
  properties JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT graph_nodes_project_node_key_pkey PRIMARY KEY (project_id, node_key),
  CONSTRAINT graph_nodes_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
  CONSTRAINT graph_nodes_kind_check
    CHECK (kind IN ('document', 'actor', 'topic')),
  CONSTRAINT graph_nodes_node_key_check
    CHECK (btrim(node_key) <> ''),
  CONSTRAINT graph_nodes_subtype_nonblank_check
    CHECK (subtype IS NULL OR btrim(subtype) <> ''),
  CONSTRAINT graph_nodes_properties_object_check
    CHECK (jsonb_typeof(properties) = 'object')
);

CREATE TABLE IF NOT EXISTS public.graph_edges (
  project_id UUID NOT NULL,
  source_node_key TEXT NOT NULL,
  target_node_key TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT graph_edges_project_source_target_relation_key
    PRIMARY KEY (project_id, source_node_key, target_node_key, relation_type),
  CONSTRAINT graph_edges_source_node_fkey
    FOREIGN KEY (project_id, source_node_key)
    REFERENCES public.graph_nodes (project_id, node_key) ON DELETE CASCADE,
  CONSTRAINT graph_edges_target_node_fkey
    FOREIGN KEY (project_id, target_node_key)
    REFERENCES public.graph_nodes (project_id, node_key) ON DELETE CASCADE,
  CONSTRAINT graph_edges_relation_type_check
    CHECK (
      relation_type IN (
        'AUTHORED',
        'COMMENTED_ON',
        'MENTIONS',
        'OWNS',
        'REPLY_TO',
        'RELATED_TO',
        'REVIEWED',
        'SAME_AS',
        'SENT'
      )
    ),
  CONSTRAINT graph_edges_properties_object_check
    CHECK (jsonb_typeof(properties) = 'object')
);

CREATE INDEX IF NOT EXISTS graph_edges_project_source_relation_target_idx
  ON public.graph_edges (project_id, source_node_key, relation_type, target_node_key);

CREATE INDEX IF NOT EXISTS graph_edges_project_target_relation_source_idx
  ON public.graph_edges (project_id, target_node_key, relation_type, source_node_key);
