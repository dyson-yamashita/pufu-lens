-- Migration: 0008_normalize_private_chat_history_json_arrays
-- Purpose: Normalize private chat history sources/tool_calls stored as JSON strings.
-- Existing DB notes:
--   - Some rows stored JSON arrays as JSONB strings, for example '"[...]"'.
--   - Chat history runtime guards require sources/tool_calls to be JSONB arrays.
-- Fresh DB sync:
--   - No table shape change is required for fresh DB.
--   - Add this version to the schema_migrations baseline seed.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Do not include real personal data, OAuth tokens, API keys, or secrets.

CREATE OR REPLACE FUNCTION pg_temp.private_chat_jsonb_array_from_string(value TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  parsed JSONB;
BEGIN
  IF value IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    parsed := value::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;

  IF jsonb_typeof(parsed) = 'array' THEN
    RETURN parsed;
  END IF;

  RETURN NULL;
END;
$$;

WITH normalized_rows AS (
  SELECT
    messages.id,
    CASE
      WHEN jsonb_typeof(messages.sources) = 'string' THEN
        pg_temp.private_chat_jsonb_array_from_string(messages.sources #>> '{}')
      ELSE NULL
    END AS normalized_sources,
    CASE
      WHEN jsonb_typeof(messages.tool_calls) = 'string' THEN
        pg_temp.private_chat_jsonb_array_from_string(messages.tool_calls #>> '{}')
      ELSE NULL
    END AS normalized_tool_calls
  FROM public.private_chat_messages AS messages
  WHERE jsonb_typeof(messages.sources) = 'string'
    OR jsonb_typeof(messages.tool_calls) = 'string'
)
UPDATE public.private_chat_messages AS messages
SET
  sources = COALESCE(normalized.normalized_sources, messages.sources),
  tool_calls = COALESCE(normalized.normalized_tool_calls, messages.tool_calls)
FROM normalized_rows AS normalized
WHERE messages.id = normalized.id
  AND (
    normalized.normalized_sources IS NOT NULL
    OR normalized.normalized_tool_calls IS NOT NULL
  );

DO $$
DECLARE
  invalid_count INTEGER;
BEGIN
  SELECT count(*)
  INTO invalid_count
  FROM public.private_chat_messages
  WHERE jsonb_typeof(sources) <> 'array'
    OR jsonb_typeof(tool_calls) <> 'array';

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'private_chat_messages sources/tool_calls normalization left % invalid rows',
      invalid_count;
  END IF;
END $$;
