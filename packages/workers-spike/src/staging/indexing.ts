import { type D1Binding, rows } from '../d1/binding.js';
import { keywordStatements } from '../d1/keyword-index.js';
import { snapshotStatements } from '../vectorize/outbox.js';
import { parseSnapshot } from '../vectorize/snapshot.js';

/** Commits one synthetic document's full snippet text, semantic revision and delivery intent atomically.
 * All chunks must share document metadata. The snippet is the complete fixture content, not a
 * truncation of a real document. Old revisions cannot replace keywords; empty chunks remove them.
 * This is a bounded evaluation ingestion boundary, not the application's ingestion pipeline.
 */
export async function commitIndexedSnapshot(db: D1Binding, value: unknown): Promise<void> {
  const snapshot = await parseSnapshot(value);
  const statements = await snapshotStatements(db, snapshot);
  const metadata = snapshot.chunks[0]?.candidate;
  if (metadata) {
    for (const { candidate } of snapshot.chunks) {
      if (
        ['rawDocumentId', 'title', 'docType', 'canonicalUri'].some(
          (key) =>
            candidate[key as keyof typeof candidate] !== metadata[key as keyof typeof metadata],
        )
      )
        throw new Error('Inconsistent document metadata');
    }
    statements.push(
      ...keywordStatements(
        db,
        {
          ...metadata,
          projectId: snapshot.projectId,
          chunks: snapshot.chunks.map(({ candidate }) => ({
            ...candidate,
            content: candidate.snippet,
          })),
        },
        snapshot.revision,
      ),
    );
  } else {
    statements.push(
      db
        .prepare(`DELETE FROM keyword_documents WHERE project_id=?1 AND document_id=?2
      AND EXISTS (SELECT 1 FROM semantic_heads WHERE project_id=?1 AND document_id=?2 AND revision=?3)`)
        .bind(snapshot.projectId, snapshot.documentId, snapshot.revision),
    );
  }
  (await db.batch(statements)).forEach(rows);
}
