-- Migration: 0004_pgroonga_hybrid_search
-- Purpose: Enable PGroonga keyword search for chat hybrid retrieval.
-- Existing DB notes: Existing document_chunks.content values are indexed directly; no backfill is required.
-- Deploy order (production / staging):
--   1. Rebuild and roll out infra/docker/postgres image with PGroonga packages.
--   2. Run `pnpm db:migrate` to apply this migration.
--   3. Verify `SELECT extname FROM pg_extension WHERE extname = 'pgroonga';`
-- Fresh DB sync:
--   - Reflect the final schema in infra/docker/postgres/init.sql.
--   - Add this version to the schema_migrations baseline seed when init.sql includes it.
-- Rollback:
--   - Standard recovery is backup restore or a forward-fix migration, not a down migration.
-- PII / secret / token check:
--   - Do not include real personal data, OAuth tokens, API keys, or secrets.

-- DDL
CREATE EXTENSION IF NOT EXISTS pgroonga;

CREATE INDEX IF NOT EXISTS document_chunks_content_pgroonga_idx
ON public.document_chunks
USING pgroonga (content);

-- Validation
