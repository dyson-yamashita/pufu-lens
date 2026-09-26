import { fuseRankedChunkCandidates } from '@pufu-lens/retrieval';
import { type D1Binding, record, rows } from '../d1/binding.js';
import { createD1KeywordCandidateRepository } from '../d1/keyword.js';
import { createD1GraphMutationRepository } from '../d1/mutation.js';
import { createD1GraphReadRepository } from '../d1/read.js';
import type { IndexContract, VectorizeBinding } from '../vectorize/binding.js';
import { deliverOutbox, inspectOutbox, outboxKey, repairOutbox } from '../vectorize/outbox.js';
import { createVectorizeCandidateRepository } from '../vectorize/semantic.js';
import { fixture, fixtureSnapshot, fixtureVector } from './fixture.js';
import { commitIndexedSnapshot } from './indexing.js';

export interface StagingEnv {
  DB: D1Binding;
  VECTORIZE: VectorizeBinding;
  PUFU_LENS_DATA_PROFILE: string;
  STAGE: string;
  FIXTURE_VERSION: string;
  SCHEMA_VERSION: string;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: string;
  INDEXED_METADATA: string;
  EXPIRES_AT: string;
  EVAL_TOKEN: string;
}

/** Rejects implicit/production profiles and stale deployments before any provider access.
 * Token is a deployment secret with at least 32 URL-safe characters, never an application credential.
 */
export function validateStagingEnv(env: StagingEnv): void {
  const remaining = Date.parse(env.EXPIRES_AT) - Date.now();
  if (
    env.PUFU_LENS_DATA_PROFILE !== 'cloudflare' ||
    env.STAGE !== 'synthetic-staging' ||
    env.FIXTURE_VERSION !== fixture.version ||
    env.SCHEMA_VERSION !== fixture.schema ||
    env.EMBEDDING_MODEL !== fixture.model ||
    env.EMBEDDING_DIMENSIONS !== '1536' ||
    env.INDEXED_METADATA !== 'projectId,model' ||
    !Number.isFinite(remaining) ||
    remaining <= 0 ||
    remaining > 86_400_000 ||
    typeof env.EVAL_TOKEN !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(env.EVAL_TOKEN) ||
    !env.DB ||
    typeof env.DB.prepare !== 'function' ||
    typeof env.DB.batch !== 'function' ||
    !env.VECTORIZE ||
    ['describe', 'query', 'upsert', 'deleteByIds'].some(
      (key) => typeof env.VECTORIZE[key as keyof VectorizeBinding] !== 'function',
    )
  )
    throw new Error('Invalid staging configuration');
}

/** Composes the existing capabilities after schema and live index shape guards.
 * Called only after authentication. No fallback to GCP and no per-request provider selection.
 * Metadata index existence requires separate remote operator evidence; describe cannot prove it.
 */
export async function createStagingComposition(env: StagingEnv) {
  validateStagingEnv(env);
  const schema = rows(await env.DB.prepare('SELECT version FROM spike_schema').all());
  if (schema.length !== 1 || record(schema[0]).version !== fixture.schema)
    throw new Error('Schema mismatch');
  // Validate required columns even when a version marker has been copied onto an incomplete DB.
  (
    await env.DB.batch(
      [
        'SELECT id FROM projects LIMIT 0',
        'SELECT project_id,node_key,kind,subtype,properties FROM graph_nodes LIMIT 0',
        'SELECT project_id,source_node_key,target_node_key,relation_type,properties FROM graph_edges LIMIT 0',
        'SELECT project_id,document_id,raw_document_id,doc_type,title,canonical_uri FROM keyword_documents LIMIT 0',
        'SELECT project_id,chunk_id,document_id,chunk_index,content,normalized_content FROM keyword_chunks LIMIT 0',
        'SELECT project_id,token,chunk_id FROM keyword_characters LIMIT 0',
        'SELECT project_id,document_id,revision,payload FROM semantic_versions LIMIT 0',
        'SELECT project_id,document_id,revision FROM semantic_heads LIMIT 0',
        'SELECT project_id,document_id,revision,state,attempts,next_attempt,mutation_id,epoch FROM semantic_outbox LIMIT 0',
      ].map((sql) => env.DB.prepare(sql)),
    )
  ).forEach(rows);
  const config: IndexContract = {
    model: fixture.model,
    dimensions: 1536,
    metric: 'cosine',
    indexedMetadata: ['projectId', 'model'],
  };
  const semantic = await createVectorizeCandidateRepository(env.DB, env.VECTORIZE, config);
  const keyword = createD1KeywordCandidateRepository(env.DB);
  const graph = createD1GraphReadRepository(env.DB);
  const mutation = createD1GraphMutationRepository(env.DB);
  /** Validates a bounded project revision snapshot used to detect concurrent hybrid mutations. */
  const heads = async (projectId: string) => {
    const found = rows(
      await env.DB.prepare(
        'SELECT document_id,revision FROM semantic_heads WHERE project_id=? ORDER BY document_id LIMIT 5',
      )
        .bind(projectId)
        .all(),
    );
    if (found.length > 4) throw new Error('Fixture head budget exceeded');
    return JSON.stringify(
      found.map((value) => {
        const row = record(value);
        return outboxKey({ projectId, documentId: row.document_id, revision: row.revision });
      }),
    );
  };
  return {
    /** Writes only one fixed document snapshot; retries and older revisions are safe. */
    async seed(projectId: string, document: number, revision: number) {
      const snapshot = fixtureSnapshot(projectId, document, revision);
      rows(
        await env.DB.prepare('INSERT INTO projects(id) VALUES (?) ON CONFLICT DO NOTHING')
          .bind(projectId)
          .all(),
      );
      await commitIndexedSnapshot(env.DB, snapshot);
    },
    /** Seeds a fixed graph independently of retrieval ingestion; retries repair partial setup. */
    async seedGraph(projectId: string) {
      for (const documentId of fixture.documents)
        await mutation.upsertNode({
          projectId,
          graphNodeId: documentId,
          labels: ['Document'],
          properties: { documentId, docType: 'web_page' },
        });
      await mutation.upsertEdge({
        projectId,
        fromGraphNodeId: 'doc-0',
        toGraphNodeId: 'doc-1',
        relationType: 'RELATED_TO',
        properties: {},
      });
    },
    /** Processes at most four due D1 intents sequentially, with no queue/resource dependency.
     * Returns only durable submission state; repeat later for due retries. D1 failures propagate.
     */
    async dispatch(projectId: string) {
      const now = Date.now();
      const pending = rows(
        await env.DB.prepare(`SELECT document_id,revision FROM semantic_outbox
        WHERE project_id=?1 AND state='pending' AND attempts<3 AND next_attempt<=?2
        ORDER BY next_attempt,document_id,revision LIMIT 4`)
          .bind(projectId, now)
          .all(),
      );
      const results = [];
      for (const value of pending) {
        const row = record(value);
        const key = outboxKey({ projectId, documentId: row.document_id, revision: row.revision });
        results.push({
          ...key,
          state: await deliverOutbox(env.DB, env.VECTORIZE, config, key, now),
        });
      }
      return results;
    },
    /** Requeues one known fixture revision; delivery is a separate bounded invocation. */
    repair: (projectId: string, document: number, revision: number) =>
      repairOutbox(env.DB, {
        projectId,
        documentId: fixtureSnapshot(projectId, document, revision).documentId,
        revision,
      }),
    /** Returns IDs and durable delivery states only, never vectors or content. */
    inspect: (projectId: string, document: number) =>
      inspectOutbox(env.DB, projectId, fixtureSnapshot(projectId, document, 1).documentId),
    /** Runs fixed Graph/keyword/semantic/Core RRF probes. Eventual visibility remains a remote gate. */
    async query(projectId: string, document: number) {
      const before = await heads(projectId);
      const semanticCandidates = await semantic.search({
        projectId,
        embedding: fixtureVector(document),
        embeddingModel: fixture.model,
        limit: 4,
        preDedupLimit: 8,
      });
      const keywordCandidates = await keyword.search({
        projectId,
        normalizedQuery: `fixturetoken${document}`,
        limit: 8,
      });
      const related = await graph.findRelatedDocuments({
        projectId,
        seedDocumentIds: [fixtureSnapshot(projectId, document, 1).documentId],
      });
      if (related.status !== 'success') throw new Error('Graph unavailable');
      if (before !== (await heads(projectId))) throw new Error('Concurrent revision change');
      const ids = (values: readonly { documentId: string }[]) => values.map((v) => v.documentId);
      return {
        semantic: ids(semanticCandidates),
        semanticDetails: semanticCandidates.map(
          ({ documentId, rawDocumentId, cosineDistance }) => ({
            documentId,
            rawDocumentId,
            cosineDistance,
          }),
        ),
        keyword: ids(keywordCandidates),
        hybrid: ids(fuseRankedChunkCandidates({ semanticCandidates, keywordCandidates, limit: 4 })),
        graph: related.candidates,
      };
    },
  };
}
