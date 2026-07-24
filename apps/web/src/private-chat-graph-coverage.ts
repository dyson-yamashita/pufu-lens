import {
  type ChatEmbeddingProvider,
  type ChatGraphQueryStatus,
  type ChatGraphRelatedSource,
  type ChatGraphRelationType,
  type ChatRepository,
  type ChatSource,
  embedPrivateChatQueries,
  GRAPH_RELATION_POOL_LIMITS,
  isChatGraphRelatedSource,
  shouldUseGraphRelatedSource,
} from './chat.ts';

export type { ChatGraphQueryStatus };
export { GRAPH_RELATION_POOL_LIMITS };

export interface GraphCoverageDiagnostics {
  readonly adoptedCount: number;
  readonly duplicateExcluded: number;
  readonly invalidRelationExcluded: number;
  readonly noEvidenceExcluded: number;
  readonly relationAdoptedCounts: Readonly<Record<ChatGraphRelationType, number>>;
  readonly relationCandidateCounts: Readonly<Record<ChatGraphRelationType, number>>;
  readonly seedCount: number;
  readonly sourceLimitExcluded: number;
}

export interface GraphCoveragePassResult {
  readonly diagnostics: GraphCoverageDiagnostics;
  readonly graphSources: readonly ChatGraphRelatedSource[];
  readonly graphStatus: ChatGraphQueryStatus;
}

const GRAPH_COVERAGE_EVIDENCE_HYBRID_LIMIT = 50;
const GRAPH_PRIORITIZED_OPERATIONS = new Set(['cause', 'comparison', 'process', 'relation']);

const EMPTY_RELATION_COUNTS = (): Record<ChatGraphRelationType, number> => ({
  MENTIONS: 0,
  RELATED_TO: 0,
  SAME_AS: 0,
});

/**
 * Returns true when graph supplement sources should be prioritized in final selection.
 */
export function shouldPrioritizeGraphCoverageSupplement(classification: {
  readonly primaryOperation: string;
}): boolean {
  return GRAPH_PRIORITIZED_OPERATIONS.has(classification.primaryOperation);
}

/**
 * Collects unique hybrid / keyword evidence queries from the original question and query plan.
 */
export function collectGraphCoverageEvidenceQueries(input: {
  readonly plan: {
    readonly expandedQueries: ReadonlyArray<{ readonly query: string }>;
    readonly primaryQuery: string;
    readonly simplifiedRetryQuery: string | null;
  };
  readonly question: string;
}): string[] {
  const queries = new Set<string>();
  const add = (value: string | null | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed) {
      queries.add(trimmed);
    }
  };
  add(input.question);
  add(input.plan.primaryQuery);
  for (const candidate of input.plan.expandedQueries) {
    add(candidate.query);
  }
  add(input.plan.simplifiedRetryQuery);
  return [...queries];
}

/**
 * Builds the union of document IDs that hybrid search confirms for the evidence queries.
 */
export async function buildHybridEvidenceDocumentIds(input: {
  readonly embeddingProvider: ChatEmbeddingProvider;
  readonly projectId: string;
  readonly queries: readonly string[];
  readonly repository: ChatRepository;
}): Promise<Set<string>> {
  if (input.queries.length === 0) {
    return new Set();
  }
  const embeddings = await embedPrivateChatQueries(input.embeddingProvider, [...input.queries]);
  const evidenceDocumentIds = new Set<string>();
  await Promise.all(
    input.queries.map(async (query, index) => {
      const embedding = embeddings[index];
      if (!embedding) {
        return;
      }
      const sources = await input.repository.hybridSearch({
        embedding,
        embeddingModel: input.embeddingProvider.model,
        limit: GRAPH_COVERAGE_EVIDENCE_HYBRID_LIMIT,
        projectId: input.projectId,
        query,
      });
      for (const source of sources) {
        if (source.documentId) {
          evidenceDocumentIds.add(source.documentId);
        }
      }
    }),
  );
  return evidenceDocumentIds;
}

/**
 * Filters graph candidates to those with hybrid chunk evidence for the question / query plan.
 */
export function filterGraphCandidatesByHybridEvidence(input: {
  readonly candidates: readonly ChatGraphRelatedSource[];
  readonly evidenceDocumentIds: ReadonlySet<string>;
  readonly question: string;
  readonly seedDocumentIds: readonly string[];
}): {
  readonly adopted: ChatGraphRelatedSource[];
  readonly diagnostics: Pick<
    GraphCoverageDiagnostics,
    'duplicateExcluded' | 'invalidRelationExcluded' | 'noEvidenceExcluded'
  >;
} {
  const adopted: ChatGraphRelatedSource[] = [];
  const seen = new Set<string>();
  let duplicateExcluded = 0;
  let invalidRelationExcluded = 0;
  let noEvidenceExcluded = 0;

  for (const candidate of input.candidates) {
    if (
      !shouldUseGraphRelatedSource({
        candidate,
        question: input.question,
        seedDocumentIds: input.seedDocumentIds,
      })
    ) {
      invalidRelationExcluded += 1;
      continue;
    }
    if (!input.evidenceDocumentIds.has(candidate.documentId)) {
      noEvidenceExcluded += 1;
      continue;
    }
    if (seen.has(candidate.documentId)) {
      duplicateExcluded += 1;
      continue;
    }
    seen.add(candidate.documentId);
    adopted.push(candidate);
  }

  return {
    adopted,
    diagnostics: {
      duplicateExcluded,
      invalidRelationExcluded,
      noEvidenceExcluded,
    },
  };
}

/**
 * Ranks graph supplement sources for relation-heavy classifications.
 *
 * `RELATED_TO` / `MENTIONS` precede `SAME_AS`, then hop count and document id.
 */
export function rankGraphCoverageSupplementSources(
  sources: readonly ChatGraphRelatedSource[],
): ChatGraphRelatedSource[] {
  const relationPriority: Record<ChatGraphRelationType, number> = {
    MENTIONS: 0,
    RELATED_TO: 1,
    SAME_AS: 2,
  };
  return [...sources].sort((left, right) => {
    const relationDelta =
      relationPriority[left.relationType] - relationPriority[right.relationType];
    if (relationDelta !== 0) {
      return relationDelta;
    }
    const hopDelta = left.hopCount - right.hopCount;
    if (hopDelta !== 0) {
      return hopDelta;
    }
    return left.documentId.localeCompare(right.documentId);
  });
}

/**
 * Reserves at least one graph-only evidence source within the final document limit when required.
 */
export function applyGraphCoverageFinalSelection(input: {
  readonly documentLimit: number;
  readonly graphOnlySources: readonly ChatGraphRelatedSource[];
  readonly prioritizeGraphSupplement: boolean;
  readonly selectedSources: readonly ChatSource[];
}): { readonly selected: ChatSource[]; readonly sourceLimitExcluded: number } {
  const selected = [...input.selectedSources];
  if (
    !input.prioritizeGraphSupplement ||
    input.graphOnlySources.length === 0 ||
    selected.length === 0
  ) {
    return { selected, sourceLimitExcluded: 0 };
  }

  const hybridDocumentIds = new Set(
    selected
      .filter((source) => source.vectorDistance !== undefined || source.fusedScore !== undefined)
      .map((source) => source.documentId),
  );
  const hasGraphOnly = selected.some(
    (source) => isChatGraphRelatedSource(source) && !hybridDocumentIds.has(source.documentId),
  );
  if (hasGraphOnly) {
    return { selected, sourceLimitExcluded: 0 };
  }

  const preferredGraphOnly =
    rankGraphCoverageSupplementSources(
      input.graphOnlySources.filter((source) => !hybridDocumentIds.has(source.documentId)),
    )[0] ?? input.graphOnlySources[0];
  if (!preferredGraphOnly) {
    return { selected, sourceLimitExcluded: 0 };
  }

  if (selected.length < input.documentLimit) {
    return { selected: [...selected, preferredGraphOnly], sourceLimitExcluded: 0 };
  }

  const removableIndex = findRemovableSourceIndex(selected, preferredGraphOnly.documentId);
  if (removableIndex === undefined) {
    return { selected, sourceLimitExcluded: 1 };
  }

  const next = [...selected];
  next.splice(removableIndex, 1);
  next.push(preferredGraphOnly);
  return { selected: next.slice(0, input.documentLimit), sourceLimitExcluded: 0 };
}

function findRemovableSourceIndex(
  sources: readonly ChatSource[],
  reservedDocumentId: string,
): number | undefined {
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const source = sources[index];
    if (!source || source.documentId === reservedDocumentId) {
      continue;
    }
    if (isChatGraphRelatedSource(source) && source.relationType === 'SAME_AS') {
      return index;
    }
  }
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const source = sources[index];
    if (!source || source.documentId === reservedDocumentId) {
      continue;
    }
    if (source.vectorDistance === undefined && source.fusedScore === undefined) {
      return index;
    }
  }
  return sources.length > 1 ? sources.length - 1 : undefined;
}

function countRelationAdoptions(
  sources: readonly ChatGraphRelatedSource[],
): Record<ChatGraphRelationType, number> {
  const counts = EMPTY_RELATION_COUNTS();
  for (const source of sources) {
    counts[source.relationType] += 1;
  }
  return counts;
}

/**
 * Runs the graph coverage pass: bounded relation pools, hybrid evidence re-check, and diagnostics.
 */
export async function runPrivateChatGraphCoveragePass(input: {
  readonly classification: { readonly primaryOperation: string };
  readonly embeddingProvider: ChatEmbeddingProvider;
  readonly graphName: string | null;
  readonly plan: {
    readonly expandedQueries: ReadonlyArray<{ readonly query: string }>;
    readonly primaryQuery: string;
    readonly simplifiedRetryQuery: string | null;
  };
  readonly projectId: string;
  readonly question: string;
  readonly repository: ChatRepository;
  readonly seedDocumentIds: readonly string[];
}): Promise<GraphCoveragePassResult> {
  const seedDocumentIds = [...new Set(input.seedDocumentIds)].filter((id) => id.trim().length > 0);
  const emptyDiagnostics: GraphCoverageDiagnostics = {
    adoptedCount: 0,
    duplicateExcluded: 0,
    invalidRelationExcluded: 0,
    noEvidenceExcluded: 0,
    relationAdoptedCounts: EMPTY_RELATION_COUNTS(),
    relationCandidateCounts: EMPTY_RELATION_COUNTS(),
    seedCount: seedDocumentIds.length,
    sourceLimitExcluded: 0,
  };

  if (!input.graphName || seedDocumentIds.length === 0) {
    return {
      diagnostics: emptyDiagnostics,
      graphSources: [],
      graphStatus: 'unavailable',
    };
  }

  const graphResult = await input.repository.graphCoverageQuery({
    graphName: input.graphName,
    projectId: input.projectId,
    question: input.question,
    seedDocumentIds,
  });

  if (graphResult.queryFailed) {
    return {
      diagnostics: {
        ...emptyDiagnostics,
        relationCandidateCounts: graphResult.relationCandidateCounts,
      },
      graphSources: [],
      graphStatus: 'unavailable',
    };
  }

  const evidenceDocumentIds = await buildHybridEvidenceDocumentIds({
    embeddingProvider: input.embeddingProvider,
    projectId: input.projectId,
    queries: collectGraphCoverageEvidenceQueries({
      plan: input.plan,
      question: input.question,
    }),
    repository: input.repository,
  });

  const orderedCandidates = shouldPrioritizeGraphCoverageSupplement(input.classification)
    ? rankGraphCoverageSupplementSources(graphResult.candidates)
    : [...graphResult.candidates];
  const filtered = filterGraphCandidatesByHybridEvidence({
    candidates: orderedCandidates,
    evidenceDocumentIds,
    question: input.question,
    seedDocumentIds,
  });
  const graphSources = filtered.adopted;

  return {
    diagnostics: {
      adoptedCount: graphSources.length,
      duplicateExcluded: filtered.diagnostics.duplicateExcluded,
      invalidRelationExcluded: filtered.diagnostics.invalidRelationExcluded,
      noEvidenceExcluded: filtered.diagnostics.noEvidenceExcluded,
      relationAdoptedCounts: countRelationAdoptions(graphSources),
      relationCandidateCounts: graphResult.relationCandidateCounts,
      seedCount: seedDocumentIds.length,
      sourceLimitExcluded: 0,
    },
    graphSources,
    graphStatus: 'success',
  };
}

/**
 * Serializes internal graph coverage diagnostics for synthesis-only retrieval context.
 */
export function formatGraphCoverageDiagnostics(
  status: ChatGraphQueryStatus,
  diagnostics: GraphCoverageDiagnostics,
): Record<string, unknown> {
  return {
    graphStatus: status,
    relationAdoptedCounts: diagnostics.relationAdoptedCounts,
    relationCandidateCounts: diagnostics.relationCandidateCounts,
    seedCount: diagnostics.seedCount,
    adoptedCount: diagnostics.adoptedCount,
    excluded: {
      duplicate: diagnostics.duplicateExcluded,
      invalidRelation: diagnostics.invalidRelationExcluded,
      noEvidence: diagnostics.noEvidenceExcluded,
      sourceLimit: diagnostics.sourceLimitExcluded,
    },
  };
}
