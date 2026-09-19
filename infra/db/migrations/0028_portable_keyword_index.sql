-- pufu-lens: no-transaction
-- Retrying rebuilds a possibly invalid index left by interrupted concurrent creation.
DROP INDEX CONCURRENTLY IF EXISTS public.document_chunks_keyword_gist_idx;
-- pufu-lens: statement-break
CREATE INDEX CONCURRENTLY document_chunks_keyword_gist_idx
ON public.document_chunks USING gist (keyword_content public.gist_trgm_ops);
