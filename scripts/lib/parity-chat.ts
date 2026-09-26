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
  runPrivateChatRetrievingStep,
} from '../../apps/web/src/private-chat-search.ts';
import { verifyQualityWorkflowHttp } from './keyword-quality-http.ts';
import type { ParityRow } from './parity-eval.ts';
import { parityFixture } from './parity-fixture.ts';
import {
  parityRetrievalDocuments,
  syntheticEmbedding,
  syntheticParityVector,
} from './parity-retrieval.ts';

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
 * Hash embeddings, fixture detail lookup and HTTP synthesis are explicit stubs. Graph, natural
 * planner, citations, HTTP authorization and answer rubric are not measured; rows stay separate.
 */
export async function collectSyntheticChat(repositories: CandidateRepositories) {
  const inputs = parityChatInputs();
  const documents = parityRetrievalDocuments();
  const rows: ParityRow[] = [];
  const observations = [];
  for (const input of inputs.filter((test) => !test.id.startsWith('failure-'))) {
    const start = performance.now();
    const candidateIds: string[] = [];
    const calls: string[] = [];
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
        return documents
          .filter(
            (document) =>
              document.projectId === query.projectId &&
              query.documentIds.includes(document.documentId),
          )
          .map((document) => {
            const source = document.chunks[0]?.candidate;
            if (!source) throw new Error('Empty Chat fixture document');
            return source;
          });
      },
    });
    const prepared = runPrivateChatPreparingStep({
      graphName: null,
      nowIso: '2026-09-26T00:00:00Z',
      projectId: input.projectId,
      question: input.question,
    });
    const retrieved = await runPrivateChatRetrievingStep(prepared, repository, {
      ...syntheticEmbedding,
      async embedTexts(texts) {
        return texts.map(syntheticParityVector);
      },
    });
    const final = await runPrivateChatDetailStep(retrieved, repository);
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
    stubs: ['sha256-embedding', 'fixture-document-fetch', 'loopback-synthesis'],
    unmeasured: [
      'natural-planner',
      'graph-query',
      'retry',
      'HTTP-authz',
      'answer-rubric',
      'citations',
      'mutation',
    ],
  };
}
