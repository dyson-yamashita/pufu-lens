import {
  createGeminiEmbeddingProvider,
  createOpenAIEmbeddingProvider,
} from '@pufu-lens/ingestion/embedding-client';
import { type D1Binding, record, text } from './d1/binding.js';
import { embedding, type IndexContract, type VectorizeBinding } from './vectorize/binding.js';
import { deliverOutbox, enqueueSnapshot, inspectOutbox, repairOutbox } from './vectorize/outbox.js';
import { createVectorizeCandidateRepository } from './vectorize/semantic.js';

const config: IndexContract = {
  model: 'synthetic-v1',
  dimensions: 1536,
  metric: 'cosine',
  indexedMetadata: ['projectId', 'model'],
};

/** Local-only synthetic harness. The HTTP fake is deliberately NOT a Vectorize REST implementation.
 * Optional test config applies equally to delivery and search for shared-fixture model labels.
 * No credentials, remote bindings or deploy configuration are provided; never publish this endpoint.
 */
export default {
  async fetch(request: Request, env: { DB: D1Binding }): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/semantic')
      return new Response(null, { status: 404 });
    try {
      const payload = record(await request.json());
      const input = record(payload.input);
      const actualConfig = { ...config, ...(payload.config ? record(payload.config) : {}) };
      const fake = async (method: string, args: unknown) => {
        const response = await fetch(`https://vectorize-fake.invalid/${method}`, {
          method: 'POST',
          body: JSON.stringify(args),
          headers: { 'content-type': 'application/json' },
        });
        if (!response.ok) throw new Error('Fake transport failure');
        return response.json();
      };
      const index: VectorizeBinding = {
        describe: () => fake('describe', {}),
        query: (values, options) => fake('query', { values, options }),
        upsert: (vectors) => fake('upsert', vectors),
        deleteByIds: (ids) => fake('delete', ids),
      };
      switch (payload.operation) {
        case 'enqueue':
          await enqueueSnapshot(env.DB, input);
          return Response.json({ result: null });
        case 'deliver':
          return Response.json({
            result: await deliverOutbox(
              env.DB,
              index,
              actualConfig,
              input,
              typeof input.now === 'number' ? input.now : undefined,
            ),
          });
        case 'repair':
          return Response.json({ result: await repairOutbox(env.DB, input) });
        case 'inspect':
          return Response.json({
            result: await inspectOutbox(env.DB, text(input.projectId), text(input.documentId)),
          });
        case 'search': {
          const repository = await createVectorizeCandidateRepository(env.DB, index, actualConfig);
          if (
            typeof input.limit !== 'number' ||
            (input.preDedupLimit !== undefined && typeof input.preDedupLimit !== 'number')
          )
            throw new Error('Invalid limit');
          return Response.json({
            result: await repository.search({
              projectId: text(input.projectId),
              embedding: embedding(input.embedding),
              embeddingModel: text(input.embeddingModel),
              limit: input.limit,
              preDedupLimit: input.preDedupLimit,
            }),
          });
        }
        case 'embedding': {
          if (!Array.isArray(input.texts) || !input.texts.every((v) => typeof v === 'string'))
            throw new Error('Invalid texts');
          const provider =
            input.provider === 'openai'
              ? createOpenAIEmbeddingProvider
              : createGeminiEmbeddingProvider;
          const client = provider({
            apiKey: 'synthetic-not-a-secret',
            model: input.provider === 'openai' ? 'text-embedding-3-small' : 'gemini-embedding-2',
            dimensions: 1536,
          });
          const vectors = await client.embedTexts(input.texts);
          vectors.forEach(embedding);
          return Response.json({ result: vectors });
        }
        default:
          return new Response(null, { status: 404 });
      }
    } catch {
      return Response.json({ error: 'unavailable' }, { status: 503 });
    }
  },
};
