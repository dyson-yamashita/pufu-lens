import { createHash } from 'node:crypto';
import { type CandidateRepositories, fuseRankedChunkCandidates } from '@pufu-lens/retrieval';
import {
  type ChatRepository,
  type ChatSource,
  normalizeHybridKeywordQuery,
  privateChatSourcesForResponse,
} from '../../apps/web/src/chat.ts';
import {
  resolvePrivateChatRetryQueries,
  runPrivateChatDetailStep,
  runPrivateChatPreparingStep,
  runPrivateChatRelatingStep,
  runPrivateChatRetrievingStep,
  runPrivateChatRetryingStep,
  shouldRunPrivateChatRetryStep,
} from '../../apps/web/src/private-chat-search.ts';
import { verifyQualityWorkflowHttp } from './keyword-quality-http.ts';
import { chatControlledScenarios } from './parity-chat-controls.ts';
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
  const natural = await collectChatCases(repositories, database, inputs);
  const controlled = [];
  for (const scenario of chatControlledScenarios) {
    const result = await collectChatCases(
      repositories,
      database,
      [scenario],
      scenario.primaryDocumentAllowlist,
    );
    controlled.push(...result.observations);
  }
  return {
    ...natural,
    embedding: syntheticEmbedding,
    inputHash: hashText(JSON.stringify(inputs)),
    qualityGate: false as const,
    connectionFixture: chatGraphConnectionFixture,
    controlled: {
      version: 'chat-controlled-connection-v1',
      inputHash: hashText(JSON.stringify(chatControlledScenarios)),
      observations: controlled,
      qualityGate: false as const,
    },
    stubs: ['sha256-embedding', 'loopback-synthesis'],
    unmeasured: [
      'natural-planner',
      'expanded-query-retry',
      'HTTP-authz',
      'answer-rubric',
      'citations',
      'mutation',
    ],
  };
}

function hashText(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

/** Runs the same steps for natural and controlled inputs. An optional allowlist only filters
 * actual primary results after adapter/RRF execution; retry and coverage reads remain unmodified.
 */
async function collectChatCases(
  repositories: CandidateRepositories,
  database: Pick<ChatRepository, 'documentFetch' | 'graphCoverageQuery'>,
  inputs: readonly { id: string; projectId: string; question: string }[],
  primaryDocumentAllowlist?: readonly string[],
) {
  const rows: ParityRow[] = [];
  const observations = [];
  for (const input of inputs.filter((test) => !test.id.startsWith('failure-'))) {
    const start = performance.now();
    const candidateIds: string[] = [];
    const calls: string[] = [];
    let phase: 'primary' | 'retry' | 'coverage' = 'primary';
    const hybridReads: {
      phase: 'primary' | 'retry' | 'coverage';
      queryHash: string;
      adapterDocumentIds: string[];
      returnedDocumentIds: string[];
    }[] = [];
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
        const fused = fuseRankedChunkCandidates({
          semanticCandidates,
          keywordCandidates,
          limit: 10,
        }).map((candidate): ChatSource => {
          candidateIds.push(candidate.chunkId);
          return {
            ...candidate,
            vectorDistance: candidate.cosineDistance,
            vectorRank: candidate.semanticRank,
          };
        });
        const returned =
          phase === 'primary' && primaryDocumentAllowlist !== undefined
            ? fused.filter((source) => primaryDocumentAllowlist.includes(source.documentId))
            : fused;
        hybridReads.push({
          phase,
          queryHash: hashText(query.query),
          adapterDocumentIds: fused.map((source) => source.documentId),
          returnedDocumentIds: returned.map((source) => source.documentId),
        });
        return returned;
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
    const retryDecision = shouldRunPrivateChatRetryStep(retrieved);
    const retryQueryHashes = resolvePrivateChatRetryQueries(retrieved).map(hashText);
    phase = 'retry';
    const retried = retryDecision
      ? await runPrivateChatRetryingStep(retrieved, repository, embeddingProvider)
      : retrieved;
    phase = 'coverage';
    const related = await runPrivateChatRelatingStep(retried, repository, embeddingProvider);
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
      input: { projectId: input.projectId, questionHash: hashText(input.question) },
      control:
        primaryDocumentAllowlist === undefined
          ? null
          : {
              boundary: 'primary-hybrid-result-after-real-adapters-and-rrf',
              primaryDocumentAllowlist: [...primaryDocumentAllowlist],
            },
      hybridReads,
      retry: {
        decision: retryDecision,
        executed: retried.didRetry,
        queryHashes: retryQueryHashes,
        beforeDocumentIds: retrieved.mergedVectorSources.map((s) => s.documentId),
        afterDocumentIds: retried.mergedVectorSources.map((s) => s.documentId),
      },
      documentReads,
      graphReads,
      graphStatus: related.graphStatus,
      graphDiagnostics: related.graphDiagnostics,
      finalGraphDiagnostics: final.graphDiagnostics,
      graphAdoptedDocumentIds: related.graphSources.map((s) => s.documentId),
      // Detail hydration can replace graph objects, so track graph-only lineage by ID.
      finalGraphDocumentIds: related.graphSources
        .filter(
          (s) =>
            !retried.mergedVectorSources.some((hybrid) => hybrid.documentId === s.documentId) &&
            sources.some((finalSource) => finalSource.documentId === s.documentId),
        )
        .map((s) => s.documentId),
      finalDocumentIds: sources.map((s) => s.documentId),
      graphExcludedFromFinalDocumentIds: related.graphSources
        .filter((s) => !sources.some((finalSource) => finalSource.documentId === s.documentId))
        .map((s) => s.documentId),
      candidateProvenancePass: true,
      workflowHttpRequests: 2,
      graphMetadataAtFinalSelection: final.sources.some((s) =>
        ['relationType', 'seedDocumentId', 'hopCount'].some((key) => key in s),
      ),
      sourceRedactionPass: sources.every((source) =>
        Object.keys(source).every((key) =>
          ['canonicalUri', 'documentId', 'docType', 'rawDocumentId', 'snippet', 'title'].includes(
            key,
          ),
        ),
      ),
      plannerPass: null,
      citationPass: null,
      scopePass: null,
      mutationPass: null,
      rubricPass: null,
      criticalErrorsMeasured: false,
    });
  }
  return {
    rows,
    observations,
  };
}
