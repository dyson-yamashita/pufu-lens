import { keywordNgrams, normalizeKeyword, parseRankedChunkCandidate } from '@pufu-lens/retrieval';
import { type D1Binding, ids, record, rows, text } from './binding.js';

/**
 * Atomically replaces one document's metadata and complete chunk set in the authorized project.
 * Caller supplies all chunks, including an empty set to remove old indexed content. Retrying the
 * same snapshot is idempotent; ordering/version arbitration belongs to the future ingestion layer.
 * Rejects malformed/oversized snapshots before writing; errors propagate without partial commits.
 * This local spike bounds each content to 8 KB and the serialized snapshot to 100 KB.
 */
export async function replaceD1KeywordDocument(db: D1Binding, value: unknown): Promise<void> {
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
  const results = await db.batch([
    db
      .prepare(`INSERT INTO keyword_documents VALUES (?1,?2,?3,?4,?5,?6)
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
      .prepare('DELETE FROM keyword_chunks WHERE project_id=?1 AND document_id=?2')
      .bind(projectId, documentId),
    db
      .prepare(`INSERT INTO keyword_chunks
      SELECT ?1,json_extract(value,'$.chunkId'),?2,json_extract(value,'$.chunkIndex'),
        json_extract(value,'$.content'),json_extract(value,'$.normalized') FROM json_each(?3)`)
      .bind(projectId, documentId, payload),
    db
      .prepare(`INSERT INTO keyword_characters
      SELECT ?1,t.value,json_extract(c.value,'$.chunkId')
      FROM json_each(?2) c, json_each(c.value,'$.tokens') t`)
      .bind(projectId, payload),
  ]);
  results.forEach(rows);
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
