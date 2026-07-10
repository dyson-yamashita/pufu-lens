-- Migration: 0010_source_version_model
-- Purpose: Add logical source identity, source versions, document logical identity, and data source sync cursor state.
-- Existing DB notes:
--   - Backfill raw_documents.logical_source_id and source_version from source-specific metadata when available.
--   - Rows without reliable metadata use legacy:<source_id> and content_hash so each legacy row stays isolated.
--   - documents.logical_source_id is copied from raw_documents; duplicate logical rows are isolated as legacy:doc:<id>.
-- Fresh DB sync:
--   - Reflect the final schema in infra/docker/postgres/init.sql.
--   - Add this version to the schema_migrations seed.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Do not include OAuth tokens, API keys, secrets, or raw document body content.

ALTER TABLE public.raw_documents
  ADD COLUMN IF NOT EXISTS logical_source_id TEXT,
  ADD COLUMN IF NOT EXISTS source_version TEXT;

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS logical_source_id TEXT;

ALTER TABLE public.data_sources
  ADD COLUMN IF NOT EXISTS sync_cursor JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_sync_succeeded_at TIMESTAMPTZ;

UPDATE public.raw_documents AS rd
SET
  logical_source_id = CASE rd.source_type
    WHEN 'gmail' THEN COALESCE(
      NULLIF(btrim(rd.metadata ->> 'threadId'), ''),
      NULLIF(split_part(rd.source_id, ':', 1), '')
    )
    WHEN 'drive' THEN COALESCE(
      NULLIF(btrim(rd.metadata ->> 'fileId'), ''),
      NULLIF(split_part(rd.source_id, ':', 1), '')
    )
    WHEN 'github' THEN rd.source_id
    WHEN 'web' THEN rd.source_id
    ELSE NULL
  END,
  source_version = CASE rd.source_type
    WHEN 'gmail' THEN COALESCE(
      NULLIF(btrim(rd.metadata ->> 'messageId'), ''),
      NULLIF(split_part(rd.source_id, ':', 2), '')
    )
    WHEN 'drive' THEN COALESCE(
      NULLIF(btrim(rd.metadata ->> 'revisionId'), ''),
      NULLIF(split_part(rd.source_id, ':', 2), '')
    )
    WHEN 'github' THEN COALESCE(NULLIF(btrim(rd.metadata ->> 'updatedAt'), ''), 'unknown') || ':' || rd.content_hash
    WHEN 'web' THEN rd.content_hash
    ELSE NULL
  END
WHERE rd.logical_source_id IS NULL
   OR rd.source_version IS NULL;

UPDATE public.raw_documents
SET
  logical_source_id = 'legacy:' || source_id,
  source_version = content_hash
WHERE logical_source_id IS NULL
   OR btrim(logical_source_id) = ''
   OR source_version IS NULL
   OR btrim(source_version) = '';

DO $$
DECLARE
  legacy_count INTEGER;
  collision_count INTEGER;
BEGIN
  SELECT count(*)
  INTO legacy_count
  FROM public.raw_documents
  WHERE logical_source_id LIKE 'legacy:%';

  SELECT count(*)
  INTO collision_count
  FROM (
    SELECT project_id, source_type, logical_source_id, source_version
    FROM public.raw_documents
    GROUP BY project_id, source_type, logical_source_id, source_version
    HAVING count(*) > 1
  ) AS collisions;

  IF collision_count > 0 THEN
    RAISE EXCEPTION
      'raw_documents logical identity collision detected in % groups before NOT NULL enforcement',
      collision_count;
  END IF;

  RAISE NOTICE 'raw_documents legacy logical identity rows: %', legacy_count;
END $$;

ALTER TABLE public.raw_documents
  ALTER COLUMN logical_source_id SET NOT NULL,
  ALTER COLUMN source_version SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.raw_documents'::regclass
      AND conname = 'raw_documents_project_source_logical_version_key'
  ) THEN
    ALTER TABLE public.raw_documents
      ADD CONSTRAINT raw_documents_project_source_logical_version_key
      UNIQUE (project_id, source_type, logical_source_id, source_version);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS raw_documents_project_source_logical_latest_idx
  ON public.raw_documents (project_id, source_type, logical_source_id, fetched_at DESC);

UPDATE public.documents AS doc
SET logical_source_id = raw.logical_source_id
FROM public.raw_documents AS raw
WHERE doc.raw_document_id = raw.id
  AND doc.logical_source_id IS NULL;

WITH ranked_documents AS (
  SELECT
    doc.id,
    row_number() OVER (
      PARTITION BY doc.project_id, doc.doc_type, doc.logical_source_id
      ORDER BY doc.occurred_at DESC NULLS LAST, doc.created_at DESC, doc.id
    ) AS row_number
  FROM public.documents AS doc
  WHERE doc.logical_source_id IS NOT NULL
)
UPDATE public.documents AS doc
SET logical_source_id = 'legacy:doc:' || doc.id::text
FROM ranked_documents AS ranked
WHERE doc.id = ranked.id
  AND ranked.row_number > 1;

UPDATE public.documents
SET logical_source_id = 'legacy:doc:' || id::text
WHERE logical_source_id IS NULL
   OR btrim(logical_source_id) = '';

DO $$
DECLARE
  legacy_doc_count INTEGER;
  collision_count INTEGER;
BEGIN
  SELECT count(*)
  INTO legacy_doc_count
  FROM public.documents
  WHERE logical_source_id LIKE 'legacy:doc:%';

  SELECT count(*)
  INTO collision_count
  FROM (
    SELECT project_id, doc_type, logical_source_id
    FROM public.documents
    GROUP BY project_id, doc_type, logical_source_id
    HAVING count(*) > 1
  ) AS collisions;

  IF collision_count > 0 THEN
    RAISE EXCEPTION
      'documents logical identity collision detected in % groups before NOT NULL enforcement',
      collision_count;
  END IF;

  RAISE NOTICE 'documents legacy logical identity rows: %', legacy_doc_count;
END $$;

ALTER TABLE public.documents
  ALTER COLUMN logical_source_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname = 'documents_project_doc_type_logical_source_key'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_project_doc_type_logical_source_key
      UNIQUE (project_id, doc_type, logical_source_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'data_sources_sync_cursor_object_check'
      AND conrelid = 'public.data_sources'::regclass
  ) THEN
    ALTER TABLE public.data_sources
      ADD CONSTRAINT data_sources_sync_cursor_object_check
      CHECK (jsonb_typeof(sync_cursor) = 'object');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.raw_documents
    WHERE logical_source_id IS NULL
       OR source_version IS NULL
  ) THEN
    RAISE EXCEPTION 'raw_documents logical identity backfill left NULL values';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.documents
    WHERE logical_source_id IS NULL
  ) THEN
    RAISE EXCEPTION 'documents logical_source_id backfill left NULL values';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.data_sources
    WHERE sync_cursor IS NULL
       OR jsonb_typeof(sync_cursor) IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'data_sources.sync_cursor must be a JSON object';
  END IF;
END $$;
