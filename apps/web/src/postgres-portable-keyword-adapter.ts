import { type KeywordCandidateRepository, KeywordQueryRejectedError } from '@pufu-lens/retrieval';
import type postgres from 'postgres';
import { portableKeywordTerms } from './portable-keyword-query.ts';
import { parsePostgresKeywordCandidateRow } from './postgres-chat-candidate-rows.ts';

/**
 * Creates the opt-in LIKE/pg_trgm candidate adapter; deployment composition stays PGroonga.
 * Uses the write-side DB normalizer and transaction-local threshold/timeout, never pool state.
 * Unbackfilled chunks are unavailable here. Errors propagate; this adapter invents no fallback.
 * All terms are required; punctuation stays literal and adjacent ASCII labels keep their numbers.
 * Trigram approximation stays at 0.6; bounded spelling variants supplement short typo retrieval.
 * Queries over 1000 UTF-16 units or limits outside 1..1000 are rejected before DB access.
 */
export function createPostgresPortableKeywordCandidateRepository(
  sql: postgres.Sql,
): KeywordCandidateRepository {
  return {
    async search({ limit, normalizedQuery, projectId }) {
      if (normalizedQuery.length > 1000 || normalizedQuery.includes('\u0000')) {
        throw new KeywordQueryRejectedError('Invalid portable keyword query.');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new KeywordQueryRejectedError('Invalid portable keyword candidate limit.');
      }
      if (!normalizedQuery.trim()) return [];
      return sql.begin(async (tx) => {
        await tx`SET LOCAL pg_trgm.word_similarity_threshold = 0.6`;
        await tx`SET LOCAL statement_timeout = '5s'`;
        const normalized: readonly unknown[] =
          await tx`SELECT public.normalize_keyword(${normalizedQuery}) AS query`;
        const row = normalized[0];
        if (!row || typeof row !== 'object' || !('query' in row) || typeof row.query !== 'string') {
          throw new Error('Invalid keyword normalization row.');
        }
        const query = row.query;
        if (!query) return [];
        const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
        const terms = portableKeywordTerms(query);
        const first = terms[0];
        if (!first) return [];
        const numericTokenPatterns =
          query.match(/[0-9]+/g)?.map((token) => `(^|[^0-9])${token}([^0-9]|$)`) ?? [];
        const rows: readonly unknown[] = await tx`
          WITH limited AS (
            SELECT dc.id::text AS chunk_id, dc.chunk_index, dc.document_id, dc.content,
              CASE WHEN dc.keyword_content LIKE ${pattern} THEN 2.0
                ELSE public.word_similarity(${query}, dc.keyword_content) END AS score
            FROM public.document_chunks dc
            JOIN public.documents d ON d.id = dc.document_id AND d.project_id = dc.project_id
            WHERE dc.project_id = ${projectId}
              AND NOT EXISTS (
                SELECT 1
                FROM unnest(${tx.array(numericTokenPatterns)}::text[]) AS required(pattern)
                WHERE dc.keyword_content !~ required.pattern
              )
              AND ((${first.literal} <> '' AND dc.keyword_content LIKE ${first.literal})
                OR (${first.approximate} <> '' AND dc.keyword_content OPERATOR(public.%>) ${first.approximate})
                OR (${first.pattern} <> '' AND dc.keyword_content ~ ${first.pattern}))
              AND NOT EXISTS (
                SELECT 1 FROM unnest(
                  ${tx.array(terms.map((term) => term.literal))}::text[],
                  ${tx.array(terms.map((term) => term.approximate))}::text[],
                  ${tx.array(terms.map((term) => term.pattern))}::text[]
                ) AS required(literal, approximate, pattern)
                WHERE NOT ((required.literal <> '' AND dc.keyword_content LIKE required.literal)
                  OR (required.approximate <> '' AND dc.keyword_content OPERATOR(public.%>) required.approximate)
                  OR (required.pattern <> '' AND dc.keyword_content ~ required.pattern))
              )
            ORDER BY score DESC, dc.id LIMIT ${limit}
          ), deduped AS (
            SELECT DISTINCT ON (d.id)
              l.chunk_id, l.chunk_index, d.id::text AS document_id,
              d.raw_document_id::text AS raw_document_id, d.doc_type,
              coalesce(d.title, 'Untitled') AS title,
              coalesce(d.canonical_uri, '') AS canonical_uri,
              left(l.content, 700) AS snippet, l.score
            FROM limited l JOIN public.documents d ON d.id = l.document_id
            WHERE d.project_id = ${projectId}
            ORDER BY d.id, l.score DESC, l.chunk_id
          )
          SELECT chunk_id, chunk_index, document_id, raw_document_id, doc_type,
            title, canonical_uri, snippet,
            row_number() OVER (ORDER BY score DESC, chunk_id) AS rank
          FROM deduped ORDER BY score DESC, chunk_id LIMIT ${limit}
        `;
        return rows.map(parsePostgresKeywordCandidateRow);
      });
    },
  };
}
