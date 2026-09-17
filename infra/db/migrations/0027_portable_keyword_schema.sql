-- Additive keyword materialization; existing rows remain NULL until bounded backfill.
-- Keep PGroonga and its rollback path. PostgreSQL 18 / UTF8 is required.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm' AND extnamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'pg_trgm must be installed in public; review existing extension placement before migration';
  END IF;
END;
$$;

-- Shared by writes, backfill and query input; Unicode full lower mapping, not casefold.
CREATE FUNCTION public.normalize_keyword(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN btrim(lower(normalize(value, NFKC) COLLATE pg_catalog."pg_unicode_fast"),
  U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');

ALTER TABLE public.document_chunks ADD COLUMN keyword_content TEXT COLLATE "C";

CREATE FUNCTION public.materialize_chunk_keyword() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.keyword_content := public.normalize_keyword(NEW.content);
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_chunks_materialize_keyword
BEFORE INSERT OR UPDATE OF content, keyword_content ON public.document_chunks
FOR EACH ROW EXECUTE FUNCTION public.materialize_chunk_keyword();
