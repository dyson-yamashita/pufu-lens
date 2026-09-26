import {
  type KeywordCandidateRepository,
  KeywordCandidateUnavailableError,
  KeywordQueryRejectedError,
  keywordNgrams,
  normalizeKeyword,
  parseRankedChunkCandidate,
  portableKeywordTerms,
} from '@pufu-lens/retrieval';
import { type D1Binding, record, rows, text } from './binding.js';

// Literal candidates, bounded typo variants and >=0.6 bigram matches necessarily share a character.
// This recall-safe indexed superset avoids FTS word boundaries and D1's 50-byte LIKE/GLOB limit.
const candidateSql = `SELECT c.chunk_id AS chunkId,c.chunk_index AS chunkIndex,
  c.document_id AS documentId,d.raw_document_id AS rawDocumentId,d.doc_type AS docType,
  d.title,d.canonical_uri AS canonicalUri,c.content,c.normalized_content AS normalized
  FROM keyword_chunks c JOIN keyword_documents d
    ON d.project_id=c.project_id AND d.document_id=c.document_id
  WHERE c.project_id=?1 AND c.chunk_id IN (
    SELECT chunk_id FROM keyword_characters WHERE project_id=?1
      AND token IN (SELECT value FROM json_each(?2)))
  ORDER BY c.chunk_id LIMIT 1001`;

/**
 * Creates a project-scoped local D1 keyword adapter. Caller handles authorization before invocation.
 * Uses literal/all-term/numeric/typo policy with per-word bigram Jaccard >=0.6 (not pg_trgm score).
 * Sorts literal matches first, then similarity and chunk ID; limits chunks before document dedupe.
 * Rejects invalid queries/limits; SQL, row validation or >1000 prefilter rows throw unavailable,
 * never a successful truncated result. No fallback or provider score crosses the Core contract.
 */
export function createD1KeywordCandidateRepository(db: D1Binding): KeywordCandidateRepository {
  return {
    async search({ projectId, normalizedQuery, limit }) {
      if (
        normalizedQuery.length > 1000 ||
        normalizedQuery.includes('\u0000') ||
        /[\uD800-\uDFFF]/u.test(normalizedQuery) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000 ||
        !projectId.trim()
      )
        throw new KeywordQueryRejectedError('Invalid D1 keyword input.');
      const query = normalizeKeyword(normalizedQuery);
      if (!query) return [];
      const terms = portableKeywordTerms(query).map((term) => ({
        literal: term.literal,
        grams: term.approximate ? keywordNgrams(term.approximate, 2) : [],
        pattern: term.pattern ? new RegExp(term.pattern, 'u') : null,
      }));
      const digits = query.match(/[0-9]+/g) ?? [];
      try {
        const found = rows(
          await db
            .prepare(candidateSql)
            .bind(
              text(projectId),
              JSON.stringify(keywordNgrams(query.split(/\s+/u)[0] ?? query, 1)),
            )
            .all(),
        );
        if (found.length > 1000) throw new Error('D1 keyword candidate budget exceeded');
        const scored = found
          .map((value) => {
            const row = record(value);
            if (
              typeof row.content !== 'string' ||
              typeof row.normalized !== 'string' ||
              row.normalized !== normalizeKeyword(row.content)
            )
              throw new Error('Invalid keyword row');
            const content = row.normalized;
            const candidate = parseRankedChunkCandidate({
              ...row,
              snippet: [...row.content].slice(0, 700).join(''),
              rank: 1,
            });
            const numbers = new Set(content.match(/[0-9]+/g) ?? []);
            const words = (content.match(/[\p{L}\p{M}]+/gu) ?? []).map(
              (word) => new Set(keywordNgrams(word, 2)),
            );
            // Compare with individual words so unrelated text cannot donate scattered grams.
            // Union size also penalizes extra letters, e.g. enabled versus disabled.
            const similarities = terms.map((term) =>
              term.grams.length
                ? Math.max(
                    0,
                    ...words.map((grams) => {
                      const intersection = term.grams.filter((gram) => grams.has(gram)).length;
                      return intersection / (term.grams.length + grams.size - intersection);
                    }),
                  )
                : 0,
            );
            const matches =
              digits.every((digit) => numbers.has(digit)) &&
              terms.every(
                (term, i) =>
                  (term.literal && content.includes(term.literal)) ||
                  term.pattern?.test(content) ||
                  (similarities[i] ?? 0) >= 0.6,
              );
            const score = content.includes(query) ? 2 : Math.min(...similarities);
            return { candidate, matches, score };
          })
          .filter((row) => row.matches)
          .sort(
            (a, b) =>
              b.score - a.score ||
              (a.candidate.chunkId < b.candidate.chunkId
                ? -1
                : a.candidate.chunkId > b.candidate.chunkId
                  ? 1
                  : 0),
          )
          .slice(0, limit);
        const seen = new Set<string>();
        return scored
          .filter(({ candidate }) => {
            if (seen.has(candidate.documentId)) return false;
            seen.add(candidate.documentId);
            return true;
          })
          .map(({ candidate }, i) => ({ ...candidate, rank: i + 1 }));
      } catch {
        throw new KeywordCandidateUnavailableError();
      }
    },
  };
}
