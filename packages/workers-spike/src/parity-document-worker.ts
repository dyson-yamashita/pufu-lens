import { type D1Binding, ids, record, rows, text } from './d1/binding.js';

/** Local-only DB detail reader, never deploy. D1 has no production Chat document repository yet.
 * Reads scoped stored metadata/first chunk; Node validates the returned Chat source rows.
 */
export default {
  async fetch(request: Request, env: { DB: D1Binding }): Promise<Response> {
    const payload = record(await request.json());
    const input = record(payload.input);
    if (!Array.isArray(input.documentIds)) throw new Error('Invalid document IDs');
    const result = await env.DB.prepare(`SELECT d.document_id, d.raw_document_id, d.doc_type,
      d.title, d.canonical_uri, NULL AS occurred_at,
      (SELECT substr(c.content,1,700) FROM keyword_chunks c
       WHERE c.project_id=d.project_id AND c.document_id=d.document_id
       ORDER BY c.chunk_index LIMIT 1) AS snippet
      FROM keyword_documents d WHERE d.project_id=?1
      AND d.document_id IN (SELECT value FROM json_each(?2)) ORDER BY d.document_id`)
      .bind(text(input.projectId), ids(input.documentIds.map(text)))
      .all();
    return Response.json({ result: rows(result) });
  },
};
