import { createHash } from 'node:crypto';
import { type CandidateRepositories, fuseRankedChunkCandidates } from '@pufu-lens/retrieval';
import {
  type ChatRepository,
  type ChatSource,
  normalizeHybridKeywordQuery,
  privateChatSourcesForResponse,
} from '../../apps/web/src/chat.ts';
import {
  runPrivateChatDetailStep,
  runPrivateChatPreparingStep,
  runPrivateChatRelatingStep,
  runPrivateChatRetrievingStep,
} from '../../apps/web/src/private-chat-search.ts';
import { verifyQualityWorkflowHttp } from './keyword-quality-http.ts';
import { chatGraphConnectionFixture } from './parity-chat-graph.ts';
import type { ParityRow } from './parity-eval.ts';
import { parityFixture } from './parity-fixture.ts';
import { syntheticEmbedding, syntheticParityVector } from './parity-retrieval.ts';

/** Maps only input fields, never required tools, relevance labels or expected answers. */
export function parityChatInputs() {
  return parityFixture.cases
    .filter((test) => test.kind === 'chat')
    .map((test) => ({
      id: test.id,
      projectId: test.projectId,
      question: test.query,
    }));
}

/** Supplies only explicitly implemented local test methods; unexpected capabilities fail closed.
 * The cast is limited to this harness proxy, whose runtime guard rejects all missing methods.
 */
export function localChatRepository(methods: Partial<ChatRepository>): ChatRepository {
  return new Proxy(methods, {
    get(target, key) {
      if (Reflect.has(target, key)) return Reflect.get(target, key);
      if (key === 'referencedDocumentFetch') return undefined;
      throw new Error(`Unmeasured local Chat capability: ${String(key)}`);
    },
  }) as ChatRepository;
}

/** Exercises real preparation/retrieval/detail selection and response redaction using real candidates.
 * Hash embeddings and HTTP synthesis are explicit stubs. Natural
 * planner, citations, HTTP authorization and answer rubric are not measured; rows stay separate.
 */
export async function collectSyntheticChat(
  repositories: CandidateRepositories,
  database: Pick<ChatRepository, 'documentFetch' | 'graphCoverageQuery'>,
) {
  const inputs = parityChatInputs();
  const rows: ParityRow[] = [];
  const observations = [];
  for (const input of inputs.filter((test) => !test.id.startsWith('failure-'))) {
    const start = performance.now();
    const candidateIds: string[] = [];
    const calls: string[] = [];
    const documentReads: { requested: string[]; returned: string[] }[] = [];
    const graphReads: {
      seeds: string[];
      returned: string[];
      relations: [string, string, string, number][];
      queryFailed: boolean;
    }[] = [];
    const repository = localChatRepository({
      async hybridSearch(query) {
        calls.push('hybrid-search');
        const semanticCandidates = await repositories.semanticCandidateRepository.search({
          projectId: query.projectId,
          embedding: query.embedding,
          embeddingModel: query.embeddingModel,
          limit: 10,
          preDedupLimit: 37,
        });
        const keywordCandidates = await repositories.keywordCandidateRepository.search({
          projectId: query.projectId,
          normalizedQuery: normalizeHybridKeywordQuery(query.query),
          limit: 20,
        });
        for (const candidate of [...semanticCandidates, ...keywordCandidates]) {
          if (
            !parityFixture.chunks.some(
              (chunk) =>
                chunk.id === candidate.chunkId &&
                chunk.documentId === candidate.documentId &&
                chunk.projectId === query.projectId,
            )
          )
            throw new Error('Invalid Chat candidate provenance');
        }
        return fuseRankedChunkCandidates({ semanticCandidates, keywordCandidates, limit: 10 }).map(
          (candidate): ChatSource => {
            candidateIds.push(candidate.chunkId);
            return {
              ...candidate,
              vectorDistance: candidate.cosineDistance,
              vectorRank: candidate.semanticRank,
            };
          },
        );
      },
      async documentFetch(query) {
        calls.push('document-fetch');
        const sources = await database.documentFetch(query);
        documentReads.push({
          requested: [...query.documentIds],
          returned: sources.map((s) => s.documentId),
        });
        for (const source of sources) {
          if (
            !query.documentIds.includes(source.documentId) ||
            !parityFixture.chunks.some(
              (c) => c.documentId === source.documentId && c.projectId === query.projectId,
            )
          )
            throw new Error('Invalid Chat document provenance');
        }
        return sources;
      },
      async graphCoverageQuery(query) {
        calls.push('graph-query');
        const result = await database.graphCoverageQuery(query);
        graphReads.push({
          seeds: [...query.seedDocumentIds],
          returned: result.candidates.map((c) => c.documentId),
          relations: result.candidates.map((c) => [
            c.seedDocumentId,
            c.relationType,
            c.documentId,
            c.hopCount,
          ]),
          queryFailed: result.queryFailed,
        });
        return result;
      },
    });
    const prepared = runPrivateChatPreparingStep({
      graphName: null,
      nowIso: '2026-09-26T00:00:00Z',
      projectId: input.projectId,
      question: input.question,
    });
    const embeddingProvider = {
      ...syntheticEmbedding,
      async embedTexts(texts: readonly string[]) {
        return texts.map(syntheticParityVector);
      },
    };
    const retrieved = await runPrivateChatRetrievingStep(prepared, repository, embeddingProvider);
    const related = await runPrivateChatRelatingStep(retrieved, repository, embeddingProvider);
    const final = await runPrivateChatDetailStep(related, repository);
    const sources = privateChatSourcesForResponse(final.sources);
    await verifyQualityWorkflowHttp({
      projectId: input.projectId,
      question: input.question,
      response: {
        status: 'answered',
        projectSlug: input.projectId,
        answer: '合成protocol検証。回答と引用は未測定。',
        sources,
        toolCalls: final.toolCalls,
      },
    });
    rows.push({
      id: input.id,
      status: 'ok',
      error: null,
      chunkIds: [...new Set(candidateIds)],
      finalDocumentIds: sources.map((source) => source.documentId),
      citationDocumentIds: [],
      tools: [...new Set(calls)],
      graph: [],
      scopePass: null,
      mutationPass: null,
      rubricPass: null,
      criticalErrors: 0,
    });
    observations.push({
      id: input.id,
      latencyMs: [performance.now() - start],
      calls,
      documentReads,
      graphReads,
      graphStatus: related.graphStatus,
      graphDiagnostics: related.graphDiagnostics,
      graphAdoptedDocumentIds: related.graphSources.map((s) => s.documentId),
      candidateProvenancePass: true,
      workflowHttpRequests: 2,
      sourceRedactionPass: sources.every((source) =>
        [
          'chunkId',
          'chunkIndex',
          'fusedScore',
          'vectorDistance',
          'vectorRank',
          'keywordRank',
          'semanticRank',
        ].every((key) => !(key in source)),
      ),
      plannerPass: null,
      citationPass: null,
      criticalErrorsMeasured: false,
    });
  }
  return {
    rows,
    observations,
    embedding: syntheticEmbedding,
    inputHash: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
    qualityGate: false as const,
    connectionFixture: chatGraphConnectionFixture,
    stubs: ['sha256-embedding', 'loopback-synthesis'],
    unmeasured: [
      'natural-planner',
      'retry',
      'HTTP-authz',
      'answer-rubric',
      'citations',
      'mutation',
    ],
  };
}
