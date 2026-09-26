import { keywordNgrams, normalizeKeyword, parseRankedChunkCandidate } from '@pufu-lens/retrieval';
import { type D1Binding, type D1Statement, ids, record, rows, text } from './binding.js';

/**
 * Atomically replaces one document's metadata and complete chunk set in the authorized project.
 * Caller supplies all chunks, including an empty set to remove old indexed content. Retrying the
 * same snapshot is idempotent; ordering/version arbitration belongs to the future ingestion layer.
 * Rejects malformed/oversized snapshots before writing; errors propagate without partial commits.
 * This local spike bounds each content to 8 KB and the serialized snapshot to 100 KB.
 */
export async function replaceD1KeywordDocument(db: D1Binding, value: unknown): Promise<void> {
  const results = await db.batch(keywordStatements(db, value));
  results.forEach(rows);
}

/** Prepares validated keyword writes for one atomic batch. If revision is supplied, the caller must
 * put semantic head writes earlier in that same batch; only the current revision may replace keywords.
 */
export function keywordStatements(db: D1Binding, value: unknown, revision?: number): D1Statement[] {
  const input = record(value);
  const projectId = text(input.projectId);
  const documentId = text(input.documentId);
  const metadata = parseRankedChunkCandidate({
    ...input,
    chunkId: 'validation',
    chunkIndex: 0,
    rank: 1,
  });
  if (!Array.isArray(input.chunks)) throw new Error('Invalid keyword chunks');
  const chunks = input.chunks.map((value: unknown) => {
    const row = record(value);
    const chunkId = text(row.chunkId);
    const chunkIndex = row.chunkIndex;
    if (!Number.isSafeInteger(chunkIndex) || typeof chunkIndex !== 'number' || chunkIndex < 0)
      throw new Error('Invalid chunk index');
    if (
      typeof row.content !== 'string' ||
      row.content.includes('\u0000') ||
      /[\uD800-\uDFFF]/u.test(row.content)
    )
      throw new Error('Invalid keyword content');
    const normalized = normalizeKeyword(row.content);
    if ([row.content, normalized].some((s) => new TextEncoder().encode(s).length > 8000))
      throw new Error('Keyword content too large');
    return {
      chunkId,
      chunkIndex,
      content: row.content,
      normalized,
      tokens: keywordNgrams(normalized, 1),
    };
  });
  if (
    new Set(chunks.map((c) => c.chunkId)).size !== chunks.length ||
    new Set(chunks.map((c) => c.chunkIndex)).size !== chunks.length
  )
    throw new Error('Duplicate keyword chunk');
  const payload = JSON.stringify(chunks);
  const metadataBytes = JSON.stringify(metadata);
  if (new TextEncoder().encode(payload + metadataBytes).length > 100_000)
    throw new Error('Keyword snapshot too large');
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
    throw new Error('Invalid keyword revision');
  const current =
    revision === undefined
      ? '1'
      : `EXISTS (SELECT 1 FROM semantic_heads WHERE project_id=?1 AND document_id=?2 AND revision=${revision})`;
  return [
    db
      .prepare(`INSERT INTO keyword_documents SELECT ?1,?2,?3,?4,?5,?6 WHERE ${current}
      ON CONFLICT(project_id,document_id) DO UPDATE SET raw_document_id=excluded.raw_document_id,
      doc_type=excluded.doc_type,title=excluded.title,canonical_uri=excluded.canonical_uri`)
      .bind(
        projectId,
        documentId,
        metadata.rawDocumentId,
        metadata.docType,
        metadata.title,
        metadata.canonicalUri,
      ),
    db
      .prepare(`DELETE FROM keyword_chunks WHERE project_id=?1 AND document_id=?2 AND ${current}`)
      .bind(projectId, documentId),
    db
      .prepare(`INSERT INTO keyword_chunks
      SELECT ?1,json_extract(value,'$.chunkId'),?2,json_extract(value,'$.chunkIndex'),
        json_extract(value,'$.content'),json_extract(value,'$.normalized') FROM json_each(?3) WHERE ${current}`)
      .bind(projectId, documentId, payload),
    db
      .prepare(`INSERT INTO keyword_characters
      SELECT ?1,t.value,json_extract(c.value,'$.chunkId')
      FROM json_each(?3) c, json_each(c.value,'$.tokens') t WHERE ${current}`)
      .bind(projectId, documentId, payload),
  ];
}

/** Deletes only the requested project's documents; FK cascades remove chunks and postings atomically. */
export async function deleteD1KeywordDocuments(
  db: D1Binding,
  projectId: string,
  documentIds: readonly string[],
): Promise<void> {
  rows(
    await db
      .prepare(
        'DELETE FROM keyword_documents WHERE project_id=?1 AND document_id IN (SELECT value FROM json_each(?2))',
      )
      .bind(text(projectId), ids(documentIds))
      .all(),
  );
}
