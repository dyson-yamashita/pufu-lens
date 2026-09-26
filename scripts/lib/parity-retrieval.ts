import { createHash } from 'node:crypto';
import {
  type CandidateRepositories,
  fuseRankedChunkCandidates,
  parseRankedChunkCandidate,
  parseSemanticChunkCandidate,
  type RankedChunkCandidate,
  RECIPROCAL_RANK_FUSION_K,
} from '@pufu-lens/retrieval';
import { normalizeHybridKeywordQuery } from '../../apps/web/src/chat.ts';
import {
  selectChatSourcesByScoreProfile,
  selectDiverseChatSources,
} from '../../apps/web/src/private-chat-search.ts';
import type { ParityRow } from './parity-eval.ts';
import { parityFixture } from './parity-fixture.ts';

export const syntheticEmbedding = {
  mode: 'synthetic',
  model: 'sha256-text-v1',
  dimensions: 1536,
  metric: 'cosine',
} as const;

/** Produces deterministic unit vectors from text alone, without judgments, IDs or oracle ranks.
 * This hash projection has no semantic meaning and must never be scored as real embedding quality.
 */
export function syntheticParityVector(text: string): number[] {
  const values: number[] = [];
  for (let block = 0; values.length < syntheticEmbedding.dimensions; block++) {
    const digest = createHash('sha256')
      .update(JSON.stringify(['sha256-text-v1', text, block]))
      .digest();
    for (const byte of digest) values.push((byte - 127.5) / 127.5);
  }
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

/** Maps the entire immutable corpus into shared provider inputs; no relevance labels are read. */
export function parityRetrievalDocuments() {
  return [...new Set(parityFixture.chunks.map((chunk) => chunk.documentId))].map((documentId) => {
    const chunks = parityFixture.chunks.filter((chunk) => chunk.documentId === documentId);
    if (!chunks[0]) throw new Error('Empty parity document');
    return {
      projectId: chunks[0].projectId,
      documentId,
      revision: 1,
      model: syntheticEmbedding.model,
      chunks: chunks.map((chunk, chunkIndex) => ({
        values: syntheticParityVector(chunk.content),
        candidate: {
          canonicalUri: `https://synthetic.invalid/${documentId}`,
          chunkId: chunk.id,
          chunkIndex,
          documentId,
          docType: 'web_page',
          rawDocumentId: `raw-${documentId}`,
          title: documentId,
          snippet: chunk.content,
        },
      })),
    };
  });
}

export const parityVectorInputHash = createHash('sha256')
  .update(
    JSON.stringify({
      documents: parityRetrievalDocuments(),
      queries: parityFixture.cases
        .filter((test) => test.kind === 'semantic' || test.kind === 'hybrid')
        .map((test) => [test.id, syntheticParityVector(test.query)]),
    }),
  )
  .digest('hex');

function checkCandidates(candidates: readonly RankedChunkCandidate[]) {
  const documents = new Set<string>();
  candidates.forEach((candidate, index) => {
    const chunk = parityFixture.chunks.find((chunk) => chunk.id === candidate.chunkId);
    if (
      !chunk ||
      chunk.documentId !== candidate.documentId ||
      candidate.rank !== index + 1 ||
      documents.has(candidate.documentId)
    )
      throw new Error('Invalid parity candidate provenance/rank');
    documents.add(candidate.documentId);
  });
}

/** Calls real candidate boundaries for six shared cases and reuses Core RRF and source selection.
 * Returned rows are synthetic local evidence only. Scope checks cover returned IDs, not HTTP authz;
 * mutation/rubric remain null. Exceptions abort collection instead of fabricating successful rows.
 */
export async function collectSyntheticRetrieval(repositories: CandidateRepositories) {
  const rows: ParityRow[] = [];
  const observations = [];
  const selectionPolicy = {
    metric: 'normalized_fused_score',
    kMin: 3,
    kMax: 10,
    relativeWindow: 0.15,
  } as const;
  for (const test of parityFixture.cases.filter(
    (test) => test.kind === 'semantic' || test.kind === 'hybrid',
  )) {
    const start = performance.now();
    const semantic = (
      await repositories.semanticCandidateRepository.search({
        projectId: test.projectId,
        embedding: syntheticParityVector(test.query),
        embeddingModel: syntheticEmbedding.model,
        limit: 10,
        preDedupLimit: 37,
      })
    ).map(parseSemanticChunkCandidate);
    const keyword =
      test.kind === 'hybrid'
        ? (
            await repositories.keywordCandidateRepository.search({
              projectId: test.projectId,
              normalizedQuery: normalizeHybridKeywordQuery(test.query),
              limit: 20,
            })
          ).map(parseRankedChunkCandidate)
        : [];
    checkCandidates(semantic);
    checkCandidates(keyword);
    const fused =
      test.kind === 'hybrid'
        ? fuseRankedChunkCandidates({
            semanticCandidates: semantic,
            keywordCandidates: keyword,
            limit: 10,
          })
        : [];
    // Normalize the two-list RRF maximum before the existing score-profile selector.
    const selected = selectDiverseChatSources(
      selectChatSourcesByScoreProfile(
        fused.map((candidate) => ({
          ...candidate,
          fusedScore: candidate.fusedScore / (2 / (RECIPROCAL_RANK_FUSION_K + 1)),
        })),
        selectionPolicy,
      ),
      {},
      5,
    );
    const scopePass = [...semantic, ...keyword].every((candidate) =>
      parityFixture.chunks.some(
        (chunk) => chunk.id === candidate.chunkId && chunk.projectId === test.projectId,
      ),
    );
    rows.push({
      id: test.id,
      status: 'ok',
      error: null,
      chunkIds: (test.kind === 'semantic' ? semantic : fused).map((candidate) => candidate.chunkId),
      finalDocumentIds: selected.map((candidate) => candidate.documentId),
      citationDocumentIds: [],
      tools: [],
      graph: [],
      scopePass,
      mutationPass: null,
      rubricPass: null,
      criticalErrors: 0,
    });
    observations.push({
      id: test.id,
      latencyMs: [performance.now() - start],
      semanticChunkIds: semantic.map((candidate) => candidate.chunkId),
      keywordChunkIds: keyword.map((candidate) => candidate.chunkId),
    });
  }
  return {
    rows,
    observations,
    inputHash: parityVectorInputHash,
    embedding: syntheticEmbedding,
    selection: { ...selectionPolicy, finalLimit: 5, runtime: 'node-local' },
    qualityGate: false as const,
  };
}
