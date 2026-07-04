-- Migration: 0009_normalize_jsonb_string_storage
-- Purpose: Normalize JSONB columns that were stored as JSON strings by double serialization.
-- Existing DB notes:
--   - postgres.js serializes jsonb parameters automatically. Passing JSON.stringify(value)::jsonb
--     stored JSONB strings instead of objects/arrays.
--   - Chat history falls back for unrecoverable optional JSON fields to keep history readable.
-- Fresh DB sync:
--   - No table shape change is required for fresh DB.
--   - Add this version to the schema_migrations baseline seed.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Do not include real personal data, OAuth tokens, API keys, or secrets.

CREATE OR REPLACE FUNCTION pg_temp.jsonb_from_jsonb_string(value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  parsed JSONB;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'string' THEN
    RETURN value;
  END IF;

  BEGIN
    parsed := (value #>> '{}')::jsonb;
    RETURN parsed;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.private_chat_sources_are_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN value IS NULL OR jsonb_typeof(value) <> 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS source(item)
      WHERE jsonb_typeof(source.item) <> 'object'
        OR jsonb_typeof(source.item -> 'canonicalUri') IS DISTINCT FROM 'string'
        OR jsonb_typeof(source.item -> 'documentId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(source.item -> 'docType') IS DISTINCT FROM 'string'
        OR jsonb_typeof(source.item -> 'rawDocumentId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(source.item -> 'title') IS DISTINCT FROM 'string'
        OR (
          source.item ? 'snippet'
          AND jsonb_typeof(source.item -> 'snippet') NOT IN ('null', 'string')
        )
    )
  END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.private_chat_tool_calls_are_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN value IS NULL OR jsonb_typeof(value) <> 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS tool_call(item)
      WHERE jsonb_typeof(tool_call.item) <> 'object'
        OR tool_call.item ->> 'name' IS NULL
        OR tool_call.item ->> 'name' NOT IN (
          'document-fetch',
          'graph-query',
          'parsed-doc-fetch',
          'raw-document-fetch',
          'vector-search'
        )
        OR jsonb_typeof(tool_call.item -> 'resultCount') IS DISTINCT FROM 'number'
        OR (tool_call.item ->> 'resultCount') !~ '^[0-9]+$'
    )
  END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.private_chat_editing_is_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN value IS NULL THEN true
    WHEN jsonb_typeof(value) <> 'object'
      OR jsonb_typeof(value -> 'caveats') IS DISTINCT FROM 'array'
      OR jsonb_typeof(value -> 'operations') IS DISTINCT FROM 'array'
      OR value ->> 'confidence' IS NULL
      OR value ->> 'confidence' NOT IN ('high', 'low', 'medium')
      OR value ->> 'inferredMode' IS NULL
      OR value ->> 'inferredMode' NOT IN (
        'default',
        'issue_mapping',
        'next_actions',
        'risk_scan',
        'structure',
        'summary',
        'timeline'
      )
      OR value ->> 'questionType' IS NULL
      OR value ->> 'questionType' NOT IN (
        'fact',
        'planning',
        'public_explanation',
        'risk',
        'status',
        'timeline',
        'unknown'
      )
    THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value -> 'caveats') AS caveat(item)
      WHERE jsonb_typeof(caveat.item) <> 'string'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value -> 'operations') AS operation(item)
      WHERE jsonb_typeof(operation.item) <> 'string'
    )
  END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.custom_report_layout_is_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'object'
    AND value ->> 'schema_version' = 'custom-report-layout-v1'
    AND jsonb_typeof(value -> 'root') IS NOT DISTINCT FROM 'object', false);
$$;

WITH normalized_rows AS (
  SELECT
    messages.id,
    pg_temp.jsonb_from_jsonb_string(messages.editing) AS normalized_editing,
    pg_temp.jsonb_from_jsonb_string(messages.sources) AS normalized_sources,
    pg_temp.jsonb_from_jsonb_string(messages.tool_calls) AS normalized_tool_calls
  FROM public.private_chat_messages AS messages
  WHERE jsonb_typeof(messages.editing) = 'string'
    OR jsonb_typeof(messages.sources) = 'string'
    OR jsonb_typeof(messages.tool_calls) = 'string'
)
UPDATE public.private_chat_messages AS messages
SET
  editing = CASE
    WHEN pg_temp.private_chat_editing_is_valid(normalized.normalized_editing) THEN
      normalized.normalized_editing
    ELSE NULL
  END,
  sources = CASE
    WHEN pg_temp.private_chat_sources_are_valid(normalized.normalized_sources) THEN
      normalized.normalized_sources
    ELSE '[]'::jsonb
  END,
  tool_calls = CASE
    WHEN pg_temp.private_chat_tool_calls_are_valid(normalized.normalized_tool_calls) THEN
      normalized.normalized_tool_calls
    ELSE '[]'::jsonb
  END
FROM normalized_rows AS normalized
WHERE messages.id = normalized.id;

WITH normalized_rows AS (
  SELECT
    runs.id,
    pg_temp.jsonb_from_jsonb_string(runs.layout_snapshot) AS normalized_layout_snapshot,
    pg_temp.jsonb_from_jsonb_string(runs.judgement_summary) AS normalized_judgement_summary
  FROM public.report_template_runs AS runs
  WHERE jsonb_typeof(runs.layout_snapshot) = 'string'
    OR jsonb_typeof(runs.judgement_summary) = 'string'
)
UPDATE public.report_template_runs AS runs
SET
  layout_snapshot = COALESCE(normalized.normalized_layout_snapshot, runs.layout_snapshot),
  judgement_summary = COALESCE(normalized.normalized_judgement_summary, runs.judgement_summary)
FROM normalized_rows AS normalized
WHERE runs.id = normalized.id;

WITH normalized_rows AS (
  SELECT
    chunks.id,
    pg_temp.jsonb_from_jsonb_string(chunks.metadata) AS normalized_metadata
  FROM public.report_chunks AS chunks
  WHERE jsonb_typeof(chunks.metadata) = 'string'
)
UPDATE public.report_chunks AS chunks
SET metadata = COALESCE(normalized.normalized_metadata, chunks.metadata)
FROM normalized_rows AS normalized
WHERE chunks.id = normalized.id;

WITH normalized_rows AS (
  SELECT
    templates.id,
    pg_temp.jsonb_from_jsonb_string(templates.layout) AS normalized_layout
  FROM public.custom_report_templates AS templates
  WHERE jsonb_typeof(templates.layout) = 'string'
)
UPDATE public.custom_report_templates AS templates
SET layout = COALESCE(normalized.normalized_layout, templates.layout)
FROM normalized_rows AS normalized
WHERE templates.id = normalized.id;

DO $$
DECLARE
  invalid_count INTEGER;
BEGIN
  SELECT count(*)
  INTO invalid_count
  FROM public.private_chat_messages
  WHERE NOT pg_temp.private_chat_editing_is_valid(editing)
    OR NOT pg_temp.private_chat_sources_are_valid(sources)
    OR NOT pg_temp.private_chat_tool_calls_are_valid(tool_calls);

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'private_chat_messages JSONB normalization left % invalid rows', invalid_count;
  END IF;

  SELECT count(*)
  INTO invalid_count
  FROM public.report_template_runs
  WHERE NOT pg_temp.custom_report_layout_is_valid(layout_snapshot)
    OR jsonb_typeof(judgement_summary) <> 'object';

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'report_template_runs JSONB normalization left % invalid rows', invalid_count;
  END IF;

  SELECT count(*)
  INTO invalid_count
  FROM public.report_chunks
  WHERE jsonb_typeof(metadata) <> 'object';

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'report_chunks JSONB normalization left % invalid rows', invalid_count;
  END IF;

  SELECT count(*)
  INTO invalid_count
  FROM public.custom_report_templates
  WHERE NOT pg_temp.custom_report_layout_is_valid(layout);

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'custom_report_templates JSONB normalization left % invalid rows', invalid_count;
  END IF;
END $$;
