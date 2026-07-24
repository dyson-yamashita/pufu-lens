import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ChatEmbeddingProvider,
  type ChatGraphRelatedSource,
  PRIVATE_CHAT_VECTOR_DIMENSIONS,
} from './chat.ts';
import {
  applyGraphCoverageFinalSelection,
  buildHybridEvidenceDocumentIds,
  collectGraphCoverageEvidenceQueries,
  filterGraphCandidatesByHybridEvidence,
  formatGraphCoverageDiagnostics,
  rankGraphCoverageSupplementSources,
  runPrivateChatGraphCoveragePass,
  shouldPrioritizeGraphCoverageSupplement,
} from './private-chat-graph-coverage.ts';
import { buildPrivateChatSearchQueryPlan } from './private-chat-search.ts';
import { sampleChatSource as sampleSource } from './test-fixtures.ts';

const testEmbeddingProvider: ChatEmbeddingProvider = {
  dimensions: PRIVATE_CHAT_VECTOR_DIMENSIONS,
  model: 'gemini-test',
  async embedTexts(texts) {
    return texts.map((_, textIndex) =>
      Array.from(
        { length: PRIVATE_CHAT_VECTOR_DIMENSIONS },
        (__, dimensionIndex) => (textIndex + dimensionIndex + 1) / PRIVATE_CHAT_VECTOR_DIMENSIONS,
      ),
    );
  },
};

function graphCandidate(overrides: Partial<ChatGraphRelatedSource> = {}): ChatGraphRelatedSource {
  return {
    ...sampleSource,
    documentId: 'doc-graph-related',
    hopCount: 1,
    relationType: 'RELATED_TO',
    seedDocumentId: sampleSource.documentId,
    title: 'Related Graph Document',
    ...overrides,
  };
}

test('collectGraphCoverageEvidenceQueries deduplicates plan and question queries', () => {
  const plan = buildPrivateChatSearchQueryPlan('pufu-editorの関連資料を比較して');
  const queries = collectGraphCoverageEvidenceQueries({
    plan,
    question: 'pufu-editorの関連資料を比較して',
  });
  assert.ok(queries.includes(plan.primaryQuery));
  assert.ok(queries.includes('pufu-editorの関連資料を比較して'));
});

test('filterGraphCandidatesByHybridEvidence excludes graph-only connections without chunk evidence', () => {
  const candidate = graphCandidate();
  const filtered = filterGraphCandidatesByHybridEvidence({
    candidates: [candidate],
    evidenceDocumentIds: new Set<string>(),
    question: '関連資料を比較して',
    seedDocumentIds: [sampleSource.documentId],
  });
  assert.equal(filtered.adopted.length, 0);
  assert.equal(filtered.diagnostics.noEvidenceExcluded, 1);
});

test('filterGraphCandidatesByHybridEvidence keeps candidates with hybrid evidence', () => {
  const candidate = graphCandidate();
  const filtered = filterGraphCandidatesByHybridEvidence({
    candidates: [candidate],
    evidenceDocumentIds: new Set([candidate.documentId]),
    question: '関連資料を比較して',
    seedDocumentIds: [sampleSource.documentId],
  });
  assert.deepEqual(filtered.adopted, [candidate]);
});

test('rankGraphCoverageSupplementSources prefers RELATED_TO and MENTIONS over SAME_AS', () => {
  const ranked = rankGraphCoverageSupplementSources([
    graphCandidate({ documentId: 'doc-same', relationType: 'SAME_AS' }),
    graphCandidate({ documentId: 'doc-related', relationType: 'RELATED_TO' }),
    graphCandidate({ documentId: 'doc-mentioned', hopCount: 2, relationType: 'MENTIONS' }),
  ]);
  assert.deepEqual(
    ranked.map((source) => source.documentId),
    ['doc-mentioned', 'doc-related', 'doc-same'],
  );
});

test('applyGraphCoverageFinalSelection reserves one graph-only source for relation questions', () => {
  const hybrid = { ...sampleSource, documentId: 'doc-hybrid', vectorDistance: 0.2 };
  const graphOnly = graphCandidate({ documentId: 'doc-graph-only' });
  const filler = { ...sampleSource, documentId: 'doc-filler', vectorDistance: 0.4 };
  const result = applyGraphCoverageFinalSelection({
    documentLimit: 2,
    graphOnlySources: [graphOnly],
    prioritizeGraphSupplement: true,
    selectedSources: [hybrid, filler],
  });
  assert.deepEqual(
    result.selected.map((source) => source.documentId),
    ['doc-hybrid', 'doc-graph-only'],
  );
});

test('shouldPrioritizeGraphCoverageSupplement is true for relation / comparison / cause / process', () => {
  assert.equal(shouldPrioritizeGraphCoverageSupplement({ primaryOperation: 'relation' }), true);
  assert.equal(shouldPrioritizeGraphCoverageSupplement({ primaryOperation: 'comparison' }), true);
  assert.equal(shouldPrioritizeGraphCoverageSupplement({ primaryOperation: 'cause' }), true);
  assert.equal(shouldPrioritizeGraphCoverageSupplement({ primaryOperation: 'process' }), true);
  assert.equal(shouldPrioritizeGraphCoverageSupplement({ primaryOperation: 'general' }), false);
});

test('runPrivateChatGraphCoveragePass marks missing graph prerequisites as unavailable', async () => {
  const result = await runPrivateChatGraphCoveragePass({
    classification: { primaryOperation: 'relation' },
    embeddingProvider: testEmbeddingProvider,
    graphName: null,
    plan: buildPrivateChatSearchQueryPlan('関連資料'),
    projectId: 'project-a',
    question: '関連資料',
    repository: {
      async graphCoverageQuery() {
        throw new Error('graphCoverageQuery should not run without graphName.');
      },
    } as never,
    seedDocumentIds: [sampleSource.documentId],
  });
  assert.equal(result.graphStatus, 'unavailable');
  assert.equal(result.graphSources.length, 0);
});

test('runPrivateChatGraphCoveragePass distinguishes query failure from empty success', async () => {
  const failed = await runPrivateChatGraphCoveragePass({
    classification: { primaryOperation: 'relation' },
    embeddingProvider: testEmbeddingProvider,
    graphName: 'graph-a',
    plan: buildPrivateChatSearchQueryPlan('関連資料'),
    projectId: 'project-a',
    question: '関連資料',
    repository: {
      async graphCoverageQuery() {
        return {
          candidates: [],
          queryFailed: true,
          relationCandidateCounts: { MENTIONS: 0, RELATED_TO: 0, SAME_AS: 0 },
        };
      },
    } as never,
    seedDocumentIds: [sampleSource.documentId],
  });
  assert.equal(failed.graphStatus, 'unavailable');

  const empty = await runPrivateChatGraphCoveragePass({
    classification: { primaryOperation: 'relation' },
    embeddingProvider: testEmbeddingProvider,
    graphName: 'graph-a',
    plan: buildPrivateChatSearchQueryPlan('関連資料'),
    projectId: 'project-a',
    question: '関連資料',
    repository: {
      async graphCoverageQuery() {
        return {
          candidates: [],
          queryFailed: false,
          relationCandidateCounts: { MENTIONS: 0, RELATED_TO: 0, SAME_AS: 0 },
        };
      },
      async hybridSearch() {
        return [];
      },
    } as never,
    seedDocumentIds: [sampleSource.documentId],
  });
  assert.equal(empty.graphStatus, 'success');
  assert.equal(empty.diagnostics.adoptedCount, 0);
});

test('buildHybridEvidenceDocumentIds unions document ids across evidence queries', async () => {
  const evidence = await buildHybridEvidenceDocumentIds({
    embeddingProvider: testEmbeddingProvider,
    projectId: 'project-a',
    queries: ['query-a', 'query-b'],
    repository: {
      async hybridSearch({ query }: { query: string }) {
        return query === 'query-a'
          ? [{ ...sampleSource, documentId: 'doc-a' }]
          : [{ ...sampleSource, documentId: 'doc-b' }];
      },
    } as never,
  });
  assert.deepEqual([...evidence].sort(), ['doc-a', 'doc-b']);
});

test('filterGraphCandidatesByHybridEvidence counts cross-relation duplicates after provenance ordering', () => {
  const related = graphCandidate({ documentId: 'doc-shared', relationType: 'RELATED_TO' });
  const sameAs = graphCandidate({ documentId: 'doc-shared', relationType: 'SAME_AS' });
  const filtered = filterGraphCandidatesByHybridEvidence({
    candidates: [related, sameAs],
    evidenceDocumentIds: new Set(['doc-shared']),
    question: '関連資料を比較して',
    seedDocumentIds: [sampleSource.documentId],
  });
  assert.equal(filtered.adopted.length, 1);
  assert.equal(filtered.adopted[0]?.relationType, 'RELATED_TO');
  assert.equal(filtered.diagnostics.duplicateExcluded, 1);
});

test('applyGraphCoverageFinalSelection treats fusedScore zero as hybrid evidence', () => {
  const hybrid = { ...sampleSource, documentId: 'doc-hybrid', fusedScore: 0 };
  const graphOnly = graphCandidate({ documentId: 'doc-graph-only' });
  const filler = { ...sampleSource, documentId: 'doc-filler', fusedScore: 0.4 };
  const result = applyGraphCoverageFinalSelection({
    documentLimit: 2,
    graphOnlySources: [graphOnly],
    prioritizeGraphSupplement: true,
    selectedSources: [hybrid, filler],
  });
  assert.deepEqual(
    result.selected.map((source) => source.documentId),
    ['doc-hybrid', 'doc-graph-only'],
  );
});

test('runPrivateChatGraphCoveragePass records duplicate exclusions and relation adoption counts', async () => {
  const related = graphCandidate({ documentId: 'doc-shared', relationType: 'RELATED_TO' });
  const sameAs = graphCandidate({ documentId: 'doc-shared', relationType: 'SAME_AS' });
  const result = await runPrivateChatGraphCoveragePass({
    classification: { primaryOperation: 'relation' },
    embeddingProvider: testEmbeddingProvider,
    graphName: 'graph-a',
    plan: buildPrivateChatSearchQueryPlan('関連資料を比較して'),
    projectId: 'project-a',
    question: '関連資料を比較して',
    repository: {
      async graphCoverageQuery() {
        return {
          candidates: [sameAs, related],
          queryFailed: false,
          relationCandidateCounts: { MENTIONS: 0, RELATED_TO: 1, SAME_AS: 1 },
        };
      },
      async hybridSearch() {
        return [{ ...related, vectorDistance: 0.2 }];
      },
    } as never,
    seedDocumentIds: [sampleSource.documentId],
  });
  assert.equal(result.graphStatus, 'success');
  assert.equal(result.diagnostics.duplicateExcluded, 1);
  assert.equal(result.diagnostics.relationAdoptedCounts.RELATED_TO, 1);
  assert.equal(result.diagnostics.relationAdoptedCounts.SAME_AS, 0);
  assert.equal(result.graphSources[0]?.relationType, 'RELATED_TO');
});

test('formatGraphCoverageDiagnostics serializes internal trace fields', () => {
  const diagnostics = formatGraphCoverageDiagnostics('success', {
    adoptedCount: 1,
    duplicateExcluded: 0,
    invalidRelationExcluded: 0,
    noEvidenceExcluded: 2,
    relationAdoptedCounts: { MENTIONS: 0, RELATED_TO: 1, SAME_AS: 0 },
    relationCandidateCounts: { MENTIONS: 1, RELATED_TO: 2, SAME_AS: 1 },
    seedCount: 3,
    sourceLimitExcluded: 0,
  });
  assert.equal(diagnostics.graphStatus, 'success');
  assert.deepEqual(diagnostics.relationCandidateCounts, {
    MENTIONS: 1,
    RELATED_TO: 2,
    SAME_AS: 1,
  });
});
