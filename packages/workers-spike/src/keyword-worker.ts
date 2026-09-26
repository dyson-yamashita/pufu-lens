import { KeywordQueryRejectedError } from '@pufu-lens/retrieval';
import { type D1Binding, record, text } from './d1/binding.js';
import { createD1KeywordCandidateRepository } from './d1/keyword.js';
import { deleteD1KeywordDocuments, replaceD1KeywordDocument } from './d1/keyword-index.js';

/** Local-only unauthenticated synthetic harness; never deploy as an application endpoint. */
export default {
  async fetch(request: Request, env: { DB: D1Binding }): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/keyword')
      return new Response(null, { status: 404 });
    try {
      const payload = record(await request.json());
      const input = record(payload.input);
      switch (payload.operation) {
        case 'replace':
          await replaceD1KeywordDocument(env.DB, input);
          return Response.json({ result: null });
        case 'delete': {
          if (!Array.isArray(input.documentIds)) throw new Error('Invalid IDs');
          await deleteD1KeywordDocuments(
            env.DB,
            text(input.projectId),
            input.documentIds.map(text),
          );
          return Response.json({ result: null });
        }
        case 'search': {
          if (typeof input.normalizedQuery !== 'string' || typeof input.limit !== 'number')
            throw new KeywordQueryRejectedError('Invalid input');
          const result = await createD1KeywordCandidateRepository(env.DB).search({
            projectId: text(input.projectId),
            normalizedQuery: input.normalizedQuery,
            limit: input.limit,
          });
          return Response.json({ result });
        }
        default:
          return new Response(null, { status: 404 });
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof KeywordQueryRejectedError ? 'rejected' : 'unavailable' },
        { status: error instanceof KeywordQueryRejectedError ? 400 : 503 },
      );
    }
  },
};
