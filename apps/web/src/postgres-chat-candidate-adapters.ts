import type {
  CandidateRepositories,
  KeywordCandidateRepository,
  KeywordTransitionObserver,
  SemanticCandidateRepository,
} from '@pufu-lens/retrieval';
import {
  createKeywordTransitionRepository,
  parseKeywordTransitionMode,
} from '@pufu-lens/retrieval';
import type postgres from 'postgres';
import {
  parsePostgresKeywordCandidateRow,
  parsePostgresSemanticCandidateRow,
} from './postgres-chat-candidate-rows.ts';
import { createPostgresPortableKeywordCandidateRepository } from './postgres-portable-keyword-adapter.ts';

/** Optional server-owned keyword routing and sanitized observation hooks for PostgreSQL adapters. */
export interface PostgresKeywordCandidateRepositoryOptions {
  readonly keywordObserver?: KeywordTransitionObserver;
  readonly keywordTransitionMode?: string;
}

/**
 * Creates the pgvector-backed semantic candidate adapter for the GCP PostgreSQL profile.
 *
 * Provider SQL and raw distance rows are parsed here; callers receive only ranked candidates with
 * a normalized cosine distance.
 *
 * @param sql - PostgreSQL executor scoped by every query's explicit project id
 * @returns A semantic repository that also enforces the indexed embedding model
 */
export function createPostgresSemanticCandidateRepository(
  sql: postgres.Sql,
): SemanticCandidateRepository {
  return {
    async search({ embedding, embeddingModel, limit, preDedupLimit, projectId }) {
      const vector = `[${embedding.join(',')}]`;
      if (preDedupLimit === undefined) {
        const rows: readonly unknown[] = await sql`
          WITH distinct_chunks AS (
            SELECT DISTINCT ON (d.id)
              dc.id::text AS chunk_id,
              dc.chunk_index,
              d.id::text AS document_id,
              d.raw_document_id::text AS raw_document_id,
              d.doc_type,
              coalesce(d.title, 'Untitled') AS title,
              coalesce(d.canonical_uri, '') AS canonical_uri,
              left(coalesce(dc.content, d.summary, ''), 700) AS snippet,
              dc.embedding <=> ${vector}::vector AS cosine_distance
            FROM public.document_chunks dc
            JOIN public.documents d ON d.id = dc.document_id
            WHERE dc.project_id = ${projectId}
              AND dc.embedding_model = ${embeddingModel}
              AND dc.embedding IS NOT NULL
            ORDER BY d.id, dc.embedding <=> ${vector}::vector, dc.id
          )
          SELECT
            chunk_id,
            chunk_index,
            document_id,
            raw_document_id,
            doc_type,
            title,
            canonical_uri,
            snippet,
            cosine_distance,
            row_number() OVER (
              ORDER BY cosine_distance ASC NULLS LAST, document_id
            ) AS rank
          FROM distinct_chunks
          ORDER BY cosine_distance ASC NULLS LAST, document_id
          LIMIT ${limit}
        `;
        return rows.map(parsePostgresSemanticCandidateRow);
      }

      const rows: readonly unknown[] = await sql`
        WITH vector_chunk_candidates_limit AS (
          SELECT
            dc.id::text AS chunk_id,
            dc.chunk_index,
            d.id::text AS document_id,
            d.raw_document_id::text AS raw_document_id,
            d.doc_type,
            coalesce(d.title, 'Untitled') AS title,
            coalesce(d.canonical_uri, '') AS canonical_uri,
            left(coalesce(dc.content, d.summary, ''), 700) AS snippet,
            dc.embedding <=> ${vector}::vector AS cosine_distance
          FROM public.document_chunks dc
          JOIN public.documents d ON d.id = dc.document_id
          WHERE dc.project_id = ${projectId}
            AND dc.embedding_model = ${embeddingModel}
            AND dc.embedding IS NOT NULL
          ORDER BY dc.embedding <=> ${vector}::vector, dc.id
          LIMIT ${preDedupLimit}
        ),
        vector_document_candidates AS (
          SELECT DISTINCT ON (document_id)
            chunk_id,
            chunk_index,
            document_id,
            raw_document_id,
            doc_type,
            title,
            canonical_uri,
            snippet,
            cosine_distance
          FROM vector_chunk_candidates_limit
          ORDER BY document_id, cosine_distance, chunk_id
        )
        SELECT
          chunk_id,
          chunk_index,
          document_id,
          raw_document_id,
          doc_type,
          title,
          canonical_uri,
          snippet,
          cosine_distance,
          row_number() OVER (ORDER BY cosine_distance, chunk_id) AS rank
        FROM vector_document_candidates
        ORDER BY cosine_distance, chunk_id
        LIMIT ${limit}
      `;
      return rows.map(parsePostgresSemanticCandidateRow);
    },
  };
}

/**
 * Creates the PGroonga-backed keyword candidate adapter for the GCP PostgreSQL profile.
 *
 * The raw provider score is used only to rank and dedupe inside this adapter and is never returned.
 *
 * @param sql - PostgreSQL executor scoped by every query's explicit project id
 * @returns A keyword repository returning provider-neutral one-based ranks
 */
export function createPostgresKeywordCandidateRepository(
  sql: postgres.Sql,
): KeywordCandidateRepository {
  return {
    async search({ limit, normalizedQuery, projectId }) {
      const rows: readonly unknown[] = await sql`
        WITH keyword_chunk_candidates_limit AS (
          SELECT
            dc.id::text AS chunk_id,
            dc.chunk_index,
            dc.document_id,
            dc.content,
            pgroonga_score(dc.tableoid, dc.ctid) AS keyword_score
          FROM public.document_chunks dc
          WHERE dc.project_id = ${projectId}
            AND dc.content &@~ pgroonga_query_escape(${normalizedQuery})
          ORDER BY pgroonga_score(dc.tableoid, dc.ctid) DESC, dc.id
          LIMIT ${limit}
        ),
        keyword_document_candidates AS (
          SELECT DISTINCT ON (d.id)
            kcl.chunk_id,
            kcl.chunk_index,
            d.id::text AS document_id,
            d.raw_document_id::text AS raw_document_id,
            d.doc_type,
            coalesce(d.title, 'Untitled') AS title,
            coalesce(d.canonical_uri, '') AS canonical_uri,
            left(coalesce(kcl.content, d.summary, ''), 700) AS snippet,
            kcl.keyword_score
          FROM keyword_chunk_candidates_limit kcl
          JOIN public.documents d ON d.id = kcl.document_id
          ORDER BY d.id, kcl.keyword_score DESC, kcl.chunk_id
        ),
        keyword_candidates AS (
          SELECT
            chunk_id,
            chunk_index,
            document_id,
            raw_document_id,
            doc_type,
            title,
            canonical_uri,
            snippet,
            row_number() OVER (ORDER BY keyword_score DESC, chunk_id) AS rank
          FROM keyword_document_candidates
        )
        SELECT
          chunk_id,
          chunk_index,
          document_id,
          raw_document_id,
          doc_type,
          title,
          canonical_uri,
          snippet,
          rank
        FROM keyword_candidates
        ORDER BY rank
        LIMIT ${limit}
      `;
      return rows.map(parsePostgresKeywordCandidateRow);
    },
  };
}

/**
 * Composes the current GCP PostgreSQL semantic and keyword capabilities as one deployment profile.
 *
 * @param sql - Shared PostgreSQL executor; each adapter still applies project scope independently
 * @param options - Optional keyword transition mode and identity-free observer
 * @returns Candidate repositories used by the Postgres Chat facade
 */
export function createGcpPostgresCandidateRepositories(
  sql: postgres.Sql,
  options: PostgresKeywordCandidateRepositoryOptions = {},
): CandidateRepositories {
  const keywordTransitionMode = parseKeywordTransitionMode(
    options.keywordTransitionMode ?? process.env.PUFU_LENS_KEYWORD_TRANSITION_MODE,
  );
  const pgroongaKeywordRepository = createPostgresKeywordCandidateRepository(sql);
  const keywordCandidateRepository =
    keywordTransitionMode === 'pgroonga-primary'
      ? pgroongaKeywordRepository
      : createKeywordTransitionRepository({
          mode: keywordTransitionMode,
          observer: options.keywordObserver ?? logKeywordTransitionObservation,
          pgroonga: pgroongaKeywordRepository,
          portable: createPostgresPortableKeywordCandidateRepository(sql),
        });
  return {
    keywordCandidateRepository,
    semanticCandidateRepository: createPostgresSemanticCandidateRepository(sql),
  };
}

/** Emits sanitized keyword transition observations without query, snippet, score, or secret data. */
function logKeywordTransitionObservation(observation: unknown): void {
  console.info(JSON.stringify(observation));
}
