import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import {
  collectSyntheticRetrieval,
  parityRetrievalDocuments,
  syntheticEmbedding,
} from '../../scripts/lib/parity-retrieval.ts';
import { buildWorker } from './build.mjs';

/** Exact in-memory cosine fake, not a Vectorize emulator or evidence of ANN/remote behavior.
 * Only stored vectors and requested namespace/filter determine ranking; no fixture judgments enter.
 */
export function createParityVectorizeFake() {
  const vectors = new Map();
  const calls = { describe: 0, upsert: 0, delete: 0, query: 0 };
  return {
    calls,
    get size() {
      return vectors.size;
    },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin !== 'https://vectorize-fake.invalid')
        return new Response(null, { status: 403 });
      const body = await request.json();
      const operation = url.pathname.slice(1);
      if (!Object.hasOwn(calls, operation)) return new Response(null, { status: 404 });
      calls[operation]++;
      if (operation === 'describe')
        return Response.json({ dimensions: 1536, metric: 'cosine', vectorCount: vectors.size });
      if (operation === 'upsert') for (const vector of body) vectors.set(vector.id, vector);
      if (operation === 'delete') for (const id of body) vectors.delete(id);
      if (operation === 'query') {
        const { values, options } = body;
        const matches = [...vectors.values()]
          .filter(
            (vector) =>
              vector.namespace === options.namespace &&
              vector.metadata.projectId === options.filter.projectId &&
              vector.metadata.model === options.filter.model,
          )
          .map((vector) => ({
            id: vector.id,
            namespace: vector.namespace,
            metadata: vector.metadata,
            score: Math.max(
              -1,
              Math.min(
                1,
                values.reduce((sum, value, i) => sum + value * vector.values[i], 0) /
                  (Math.hypot(...values) * Math.hypot(...vector.values)),
              ),
            ),
          }))
          .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, options.topK);
        return Response.json({ count: matches.length, matches });
      }
      return Response.json({ mutationId: `local-fake-${calls[operation]}` });
    },
  };
}

/** Seeds all 37 chunks/36 documents into real D1/workerd and calls real candidate adapters.
 * Vectorize alone is a cosine fake. All other egress is denied, including embedding/LLM APIs.
 */
export async function collectD1SyntheticRetrieval() {
  const { script } = await buildWorker('parity-retrieval-worker');
  const fake = createParityVectorizeFake();
  const runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: [],
    d1Databases: { DB: 'parity-retrieval-local' },
    outboundService: (request) => fake.fetch(request),
  });
  try {
    await runtime.ready;
    const db = await runtime.getD1Database('DB');
    for (const file of ['0001_graph.sql', '0002_keyword.sql', '0003_semantic.sql']) {
      const sql = await readFile(new URL(`d1/${file}`, import.meta.url), 'utf8');
      await db.batch(
        sql
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    }
    const documents = parityRetrievalDocuments();
    for (const project of new Set(documents.map((d) => d.projectId)))
      await db.prepare('INSERT INTO projects VALUES (?)').bind(project).run();
    const call = async (capability, operation, input) => {
      const response = await runtime.dispatchFetch(`http://local.test/${capability}`, {
        method: 'POST',
        body: JSON.stringify({ operation, input, config: { model: syntheticEmbedding.model } }),
      });
      if (!response.ok) throw new Error(`Local parity ${capability}/${operation} failed`);
      return (await response.json()).result;
    };
    for (const document of documents) {
      const candidate = document.chunks[0].candidate;
      await call('keyword', 'replace', {
        projectId: document.projectId,
        documentId: document.documentId,
        rawDocumentId: candidate.rawDocumentId,
        title: candidate.title,
        canonicalUri: candidate.canonicalUri,
        docType: candidate.docType,
        chunks: document.chunks.map(({ candidate: c }) => ({
          chunkId: c.chunkId,
          chunkIndex: c.chunkIndex,
          content: c.snippet,
        })),
      });
      await call('semantic', 'enqueue', document);
      const delivery = await call('semantic', 'deliver', {
        projectId: document.projectId,
        documentId: document.documentId,
        revision: document.revision,
      });
      if (delivery !== 'submitted') throw new Error('Synthetic vector delivery failed');
    }
    if (fake.size !== 37) throw new Error('Incomplete synthetic vector coverage');
    const result = await collectSyntheticRetrieval({
      semanticCandidateRepository: { search: (input) => call('semantic', 'search', input) },
      keywordCandidateRepository: { search: (input) => call('keyword', 'search', input) },
    });
    return {
      ...result,
      vectorize: 'fake-exact-cosine',
      fakeCalls: fake.calls,
      storedVectors: fake.size,
    };
  } finally {
    await runtime.dispose();
  }
}
