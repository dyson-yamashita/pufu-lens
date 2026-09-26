import { fuseRankedChunkCandidates } from '@pufu-lens/retrieval';
import { record, rows } from './d1/binding.js';
import { createD1KeywordCandidateRepository } from './d1/keyword.js';
import {
  type StagingEnv,
  validateCompositionSchema,
  validateStagingEnv,
} from './staging/composition.js';
import { commitIndexedSnapshot } from './staging/indexing.js';
import { measureBindings } from './staging/metrics.js';
import { authenticated } from './staging-worker.js';
import type { IndexContract } from './vectorize/binding.js';
import { deliverOutbox, inspectOutbox, repairOutbox } from './vectorize/outbox.js';
import { createVectorizeCandidateRepository } from './vectorize/semantic.js';
import type { Snapshot } from './vectorize/snapshot.js';

export interface ParityBindingFixture {
  version: string;
  fixtureHash: string;
  artifactHash: string;
  model: string;
  documents: (Omit<Snapshot, 'chunks'> & { chunks: { candidate: unknown; values: number[] }[] })[];
  queries: { id: string; projectId: string; query: string; values: number[] }[];
}

/** Builds an operator-only worker from an offline-validated, immutable bundled fixture.
 * HTTP accepts indices only. No arbitrary data, SQL, vectors, URLs or credentials enter the DB.
 * Deployment/real embedding generation require separate approval; this factory performs no IO.
 */
export function createParityBindingWorker(fixture: ParityBindingFixture) {
  return {
    async fetch(
      request: Request,
      env: StagingEnv & { ARTIFACT_HASH: string; FIXTURE_HASH: string },
    ) {
      const reply = (body: unknown, status = 200) =>
        Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/evaluate')
        return reply({ error: 'not_found' }, 404);
      try {
        validateStagingEnv(env, {
          version: fixture.version,
          schema: '0004_composition',
          model: fixture.model,
        });
        if (env.ARTIFACT_HASH !== fixture.artifactHash || env.FIXTURE_HASH !== fixture.fixtureHash)
          throw new Error('Contract mismatch');
      } catch {
        return reply({ error: 'unavailable' }, 503);
      }
      if (!(await authenticated(request, env.EVAL_TOKEN)))
        return reply({ error: 'unauthorized' }, 401);
      let operation: string;
      let index: number;
      try {
        const reader = request.body?.getReader();
        if (!reader) throw new Error('Missing control');
        let body = '';
        let size = 0;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024) {
            await reader.cancel();
            throw new Error('Oversized');
          }
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
        const input = record(JSON.parse(body));
        if (
          Object.keys(input).sort().join(',') !== 'index,operation' ||
          typeof input.operation !== 'string' ||
          typeof input.index !== 'number' ||
          !Number.isInteger(input.index) ||
          input.index < 0
        )
          throw new Error('Invalid control');
        operation = input.operation;
        index = input.index;
        if (
          !['health', 'seed', 'dispatch', 'repair', 'inspect', 'query', 'cleanup'].includes(
            operation,
          ) ||
          index >= (operation === 'query' ? fixture.queries.length : fixture.documents.length)
        )
          throw new Error('Unknown control');
      } catch {
        return reply({ error: 'invalid_control' }, 400);
      }
      const measured = measureBindings(env.DB, env.VECTORIZE);
      const { db, index: vectors } = measured;
      try {
        await validateCompositionSchema(db);
        const config: IndexContract = {
          model: fixture.model,
          dimensions: 1536,
          metric: 'cosine',
          indexedMetadata: ['projectId', 'model'],
        };
        const semantic = await createVectorizeCandidateRepository(db, vectors, config);
        const document = fixture.documents[index];
        if (!document) throw new Error('Missing bundled document');
        const key = { projectId: document.projectId, documentId: document.documentId, revision: 1 };
        let result: unknown = null;
        if (operation === 'seed') {
          rows(
            await db
              .prepare('INSERT INTO projects(id) VALUES (?) ON CONFLICT DO NOTHING')
              .bind(document.projectId)
              .all(),
          );
          await commitIndexedSnapshot(db, document);
        } else if (operation === 'dispatch') {
          result = await deliverOutbox(db, vectors, config, key);
        } else if (operation === 'repair') {
          result = await repairOutbox(db, key);
        } else if (operation === 'inspect') {
          result = await inspectOutbox(db, key.projectId, key.documentId);
        } else if (operation === 'cleanup') {
          // Keep history until remote resource deletion; old revision repair deletes immutable IDs.
          await commitIndexedSnapshot(db, { ...document, revision: 2, chunks: [] });
          await repairOutbox(db, key);
          result = await deliverOutbox(db, vectors, config, key);
        } else if (operation === 'query') {
          const query = fixture.queries[index];
          if (!query) throw new Error('Missing bundled query');
          const heads = async () =>
            JSON.stringify(
              rows(
                await db
                  .prepare(
                    'SELECT document_id,revision FROM semantic_heads WHERE project_id=? ORDER BY document_id LIMIT 37',
                  )
                  .bind(query.projectId)
                  .all(),
              ).map((value) => {
                const row = record(value);
                if (typeof row.document_id !== 'string' || !Number.isSafeInteger(row.revision))
                  throw new Error('Invalid head');
                return [row.document_id, row.revision];
              }),
            );
          const before = await heads();
          const semanticCandidates = await semantic.search({
            projectId: query.projectId,
            embedding: query.values,
            embeddingModel: fixture.model,
            limit: 10,
            preDedupLimit: 37,
          });
          const keywordCandidates = await createD1KeywordCandidateRepository(db).search({
            projectId: query.projectId,
            normalizedQuery: query.query,
            limit: 20,
          });
          const ids = (items: readonly { chunkId: string }[]) => items.map((item) => item.chunkId);
          if (before !== (await heads())) throw new Error('Concurrent revision change');
          result = {
            caseId: query.id,
            semantic: ids(semanticCandidates),
            keyword: ids(keywordCandidates),
            hybrid: ids(
              fuseRankedChunkCandidates({ semanticCandidates, keywordCandidates, limit: 10 }),
            ),
          };
        }
        return reply({
          fixtureHash: fixture.fixtureHash,
          artifactHash: fixture.artifactHash,
          result,
          usage: measured.usage,
          qualityGate: false,
        });
      } catch {
        return reply({ error: 'unavailable', usage: measured.usage }, 503);
      }
    },
  };
}
