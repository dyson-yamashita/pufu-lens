import type { TransactionSql } from 'postgres';
import { keywordCorpus } from './keyword-eval-corpus.ts';

export const portableProviders = [
  'fts-simple',
  'trgm-like-gin',
  'trgm-similarity-gin',
  'trgm-word-gin',
  'trgm-like-word-gin',
  'trgm-like-word-gist',
  'bigram',
  'trigram',
  'bigram-fuzzy',
  'trigram-fuzzy',
  'bigram-word',
] as const;
export type PortableProvider = (typeof portableProviders)[number];

/** Evaluation-only symmetric NFKC/case normalization; original corpus and baseline stay unchanged. */
export function normalizeKeyword(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

/** Produces distinct, unpadded code-point n-grams, retaining punctuation and short terms. */
export function keywordNgrams(value: string, width: number): string[] {
  const points = [...value];
  if (!points.length) return [];
  if (points.length < width) return [value];
  return [
    ...new Set(
      points.slice(0, points.length - width + 1).map((_, i) => points.slice(i, i + width).join('')),
    ),
  ];
}

/** Escapes LIKE metacharacters so bound queries have literal substring semantics. */
export function keywordLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

/** Builds only eval-schema queries; project filtering precedes the fixed chunk limit/dedupe. */
export function portableQuery(
  tx: TransactionSql,
  provider: PortableProvider,
  projectId: string,
  query: string,
) {
  const like = tx`content LIKE ${keywordLike(query)}`;
  const word = tx`content %> ${query}`;
  const fts = tx`search @@ plainto_tsquery('simple', ${query})`;
  const ngrams = keywordNgrams(query, provider.startsWith('trigram') ? 3 : 2);
  const coverage = tx`(SELECT count(*)::float / ${Math.max(1, ngrams.length)} FROM keyword_eval_portable.tokens WHERE chunk_id = chunks.id AND token = ANY(${tx.array(ngrams)}::text[]))`;
  const fuzzy = tx`id IN (SELECT chunk_id FROM keyword_eval_portable.tokens
    WHERE token = ANY(${tx.array(ngrams)}::text[]) GROUP BY chunk_id
    HAVING count(*)::float / ${Math.max(1, ngrams.length)} >= 0.6)`;
  const gram = tx`id IN (
    SELECT chunk_id FROM keyword_eval_portable.tokens
    WHERE token = ANY(${tx.array(ngrams)}::text[])
    GROUP BY chunk_id HAVING count(*) = ${ngrams.length}
  ) AND ${like}`;
  const where =
    provider === 'fts-simple'
      ? fts
      : provider === 'trgm-like-gin'
        ? like
        : provider === 'trgm-similarity-gin'
          ? tx`content % ${query}`
          : provider === 'trgm-word-gin'
            ? word
            : provider.endsWith('-fuzzy')
              ? fuzzy
              : provider === 'bigram' || provider === 'trigram'
                ? gram
                : provider === 'bigram-word'
                  ? tx`((${gram}) OR ${word})`
                  : tx`(${like} OR ${word})`;
  const score =
    provider === 'fts-simple'
      ? tx`ts_rank(search, plainto_tsquery('simple', ${query}))`
      : provider === 'trgm-similarity-gin'
        ? tx`similarity(content, ${query})`
        : provider === 'trgm-word-gin'
          ? tx`word_similarity(${query}, content)`
          : provider.endsWith('-fuzzy')
            ? tx`CASE WHEN ${like} THEN 2.0 ELSE ${coverage} END`
            : provider === 'bigram' || provider === 'trigram' || provider === 'trgm-like-gin'
              ? tx`1.0`
              : tx`CASE WHEN ${like} THEN 2.0 ELSE word_similarity(${query}, content) END`;
  return tx`WITH limited AS (
    SELECT id, document_id, ${score} AS score FROM keyword_eval_portable.chunks
    WHERE project_id = ${projectId} AND (${where})
    ORDER BY score DESC, id LIMIT ${keywordCorpus.k}
  ), deduped AS (
    SELECT DISTINCT ON (document_id) id, document_id, score FROM limited
    ORDER BY document_id, score DESC, id
  ) SELECT id FROM deduped ORDER BY score DESC, id LIMIT ${keywordCorpus.k}`;
}
