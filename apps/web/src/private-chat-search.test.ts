import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ChatEmbeddingProvider,
  inferChatEditingMetadata,
  PRIVATE_CHAT_VECTOR_DIMENSIONS,
} from './chat.ts';
import { mergeHybridChatResponse } from './mastra-chat.ts';
import {
  applyPrivateChatQueryExpansion,
  applyPrivateChatQuestionClassification,
  applyPrivateChatWorkflowQueryExpansion,
  buildPrivateChatSearchQueryPlan,
  countSelectedVectorSources,
  createFallbackPrivateChatQuestionClassification,
  extractPrivateChatProtectedAnchors,
  formatPrivateChatRetrievalContext,
  fuseChatSourceRankings,
  MAX_PRIVATE_CHAT_SEARCH_QUERY_LENGTH,
  MAX_PRIVATE_CHAT_SEARCH_QUERY_VARIANTS,
  mergeChatSourcesDeterministically,
  mergeChatToolCallsDeterministically,
  privateChatSearchStageLabel,
  resolvePrivateChatRetryQueries,
  runPrivateChatDetailStep,
  runPrivateChatPreparingStep,
  runPrivateChatRetryingStep,
  runPrivateChatSearchRetrieval,
  selectChatSourcesByScoreProfile,
  shouldRunPrivateChatRetryStep,
  shouldRunPrivateChatTimelineStep,
  stripPrivateChatRequestNoise,
} from './private-chat-search.ts';
import {
  clientAcceptsPrivateChatStream,
  consumePrivateChatNdjsonStream,
  encodePrivateChatStreamEvent,
  PRIVATE_CHAT_NDJSON_STREAM_ERROR_MESSAGE,
  parsePrivateChatStreamLine,
} from './private-chat-stream.ts';
import {
  consumeMastraWorkflowStreamText,
  isPrivateChatWorkflowAbortError,
  MASTRA_WORKFLOW_RECORD_SEPARATOR,
  MAX_MASTRA_WORKFLOW_STREAM_BUFFER_BYTES,
  mapMastraWorkflowRecordToUiStage,
  mastraPrivateChatSearchCreateRunUrl,
  mastraPrivateChatSearchStreamUrl,
  PRIVATE_CHAT_STREAM_USER_ERROR_MESSAGE,
  parseMastraWorkflowStreamBuffer,
  privateChatWorkflowSafeLogMessage,
  runPrivateChatSearchViaMastraWorkflow,
} from './private-chat-workflow-client.ts';
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

test('buildPrivateChatSearchQueryPlan keeps the normalized original query as the primary search', () => {
  const question = '  pufu-editorでのエラー対応実績を教えてください  ';
  const plan = buildPrivateChatSearchQueryPlan(question);
  assert.equal(plan.primaryQuery, 'pufu-editorでのエラー対応実績を教えてください');
  assert.deepEqual(plan.expandedQueries, []);
  assert.deepEqual(plan.protectedAnchors, ['pufu-editor']);
});

test('buildPrivateChatSearchQueryPlan bounds a long original query and enables generic zero-result retry', () => {
  const longQuestion = `対象 ${'あ'.repeat(MAX_PRIVATE_CHAT_SEARCH_QUERY_LENGTH + 20)}`;
  assert.equal(
    Array.from(buildPrivateChatSearchQueryPlan(longQuestion).primaryQuery).length,
    MAX_PRIVATE_CHAT_SEARCH_QUERY_LENGTH,
  );
  const plan = buildPrivateChatSearchQueryPlan('プロジェクト概要を教えて');
  assert.equal(plan.primaryQuery, 'プロジェクト概要を教えて');
  assert.deepEqual(plan.expandedQueries, []);
  assert.equal(plan.simplifiedRetryQuery, 'プロジェクト概要');
  assert.equal(
    buildPrivateChatSearchQueryPlan('対応の詳細について pufu-editor #559').simplifiedRetryQuery,
    null,
  );
});

test('selectChatSourcesByScoreProfile handles empty, equal, and unscored legacy rankings', () => {
  const policy = { kMax: 5, kMin: 2, metric: 'vector_distance' } as const;
  assert.deepEqual(selectChatSourcesByScoreProfile([], policy), []);
  const equalSources = Array.from({ length: 6 }, (_, index) => ({
    ...sampleSource,
    documentId: `doc-equal-${index}`,
    vectorDistance: 0.2,
  }));
  assert.deepEqual(
    selectChatSourcesByScoreProfile(equalSources, policy).map((source) => source.documentId),
    ['doc-equal-0', 'doc-equal-1', 'doc-equal-2', 'doc-equal-3', 'doc-equal-4'],
  );
  assert.deepEqual(
    selectChatSourcesByScoreProfile(
      equalSources.map(({ vectorDistance: _, ...source }) => source),
      policy,
    ).map((source) => source.documentId),
    ['doc-equal-0', 'doc-equal-1', 'doc-equal-2', 'doc-equal-3', 'doc-equal-4'],
  );
});

test('selectChatSourcesByScoreProfile applies both score directions and a deterministic cliff', () => {
  const distanceSources = [0.1, 0.11, 0.12, 0.4, 0.41].map((vectorDistance, index) => ({
    ...sampleSource,
    documentId: `doc-distance-${index}`,
    vectorDistance,
  }));
  assert.deepEqual(
    selectChatSourcesByScoreProfile(distanceSources, {
      gapRatio: 1,
      kMax: 5,
      kMin: 2,
      metric: 'vector_distance',
    }).map((source) => source.documentId),
    ['doc-distance-0', 'doc-distance-1', 'doc-distance-2'],
  );
  assert.deepEqual(
    selectChatSourcesByScoreProfile(
      [0.1, 0.11, 0.2, 0.8].map((vectorDistance, index) => ({
        ...sampleSource,
        documentId: `doc-largest-gap-${index}`,
        vectorDistance,
      })),
      { gapRatio: 0.5, kMax: 4, kMin: 1, metric: 'vector_distance' },
    ).map((source) => source.documentId),
    ['doc-largest-gap-0', 'doc-largest-gap-1', 'doc-largest-gap-2'],
  );
  const fusedSources = [1, 0.9, 0.5].map((fusedScore, index) => ({
    ...sampleSource,
    documentId: `doc-fused-${index}`,
    fusedScore,
  }));
  assert.deepEqual(
    selectChatSourcesByScoreProfile(fusedSources, {
      kMax: 3,
      kMin: 1,
      metric: 'normalized_fused_score',
      minNormalizedScore: 0.9,
    }).map((source) => source.documentId),
    ['doc-fused-0', 'doc-fused-1'],
  );
  assert.throws(
    () =>
      selectChatSourcesByScoreProfile(distanceSources, {
        kMax: 2,
        kMin: 1,
        metric: 'vector_distance',
        minNormalizedScore: 0.1,
      }),
    /incompatible threshold/,
  );
});

test('unscored candidates do not suppress simplified private-chat retry', () => {
  const plan = buildPrivateChatSearchQueryPlan('プロジェクト概要 最新 更新 状況 教えてください');
  assert.equal(countSelectedVectorSources([sampleSource]), 0);
  assert.deepEqual(resolvePrivateChatRetryQueries({ mergedVectorSources: [sampleSource], plan }), [
    plan.simplifiedRetryQuery,
  ]);
});

test('applyPrivateChatQueryExpansion validates anchors, length, controls, dedupe, and count', () => {
  const validCandidates = Array.from(
    { length: MAX_PRIVATE_CHAT_SEARCH_QUERY_VARIANTS + 2 },
    (_, index) => ({
      operation: 'process' as const,
      purpose: `観点 ${index}`,
      query: `pufu-editor 対応過程 ${index}`,
    }),
  );
  const plan = applyPrivateChatQueryExpansion('pufu-editorの対応を教えて', {
    queries: [
      { operation: 'cause', purpose: '対象欠落', query: '原因 修正' },
      {
        operation: 'cause',
        purpose: '長すぎる',
        query: `pufu-editor ${'a'.repeat(MAX_PRIVATE_CHAT_SEARCH_QUERY_LENGTH)}`,
      },
      { operation: 'cause', purpose: '制御文字', query: 'pufu-editor\n原因' },
      ...validCandidates,
      { operation: 'process', purpose: '重複', query: 'PUFU-EDITOR 対応過程 0' },
    ],
  });
  assert.equal(plan.primaryQuery, 'pufu-editorの対応を教えて');
  assert.equal(plan.expandedQueries.length, MAX_PRIVATE_CHAT_SEARCH_QUERY_VARIANTS - 1);
  assert.ok(plan.expandedQueries.every(({ query }) => query.includes('pufu-editor')));
});

test('classification uses bounded fixed operations and timeline selection has a deterministic fallback', () => {
  const fallback = createFallbackPrivateChatQuestionClassification('pufu-editorの経緯');
  assert.equal(fallback.primaryOperation, 'general');
  assert.deepEqual(extractPrivateChatProtectedAnchors('pufu-editor PR #559'), [
    'pufu-editor',
    'PR',
    '#559',
  ]);
  const initial = runPrivateChatPreparingStep({
    graphName: 'graph-a',
    projectId: 'project-a',
    question: '最近の判断理由は？',
  });
  const classified = applyPrivateChatQuestionClassification(initial, {
    confidence: 'high',
    expectedEvidence: ['decision log'],
    figure: ['判断'],
    ground: ['project'],
    primaryOperation: 'decision',
    secondaryOperations: ['timeline', 'timeline', 'decision'],
  });
  assert.deepEqual(classified.classification.secondaryOperations, ['timeline']);
  assert.equal(shouldRunPrivateChatTimelineStep(classified), true);
  assert.equal(
    shouldRunPrivateChatTimelineStep(
      runPrivateChatPreparingStep({
        graphName: 'graph-a',
        projectId: 'project-a',
        question: '障害対応の経緯と時系列を教えて',
      }),
    ),
    true,
  );
});

test('protected anchor extraction stays bounded on long repeated input', () => {
  const repeatedDigits = '0'.repeat(100_000);
  assert.deepEqual(extractPrivateChatProtectedAnchors(`${repeatedDigits} pufu-editor PR #559`), [
    'pufu-editor',
    'PR',
    '#559',
  ]);
  assert.deepEqual(extractPrivateChatProtectedAnchors(`prefix-${repeatedDigits}`), []);
});

test('stripPrivateChatRequestNoise removes request phrases while preserving entity tokens', () => {
  assert.equal(
    stripPrivateChatRequestNoise('pufu-editorでのエラー対応実績教えてください'),
    'pufu-editor エラー',
  );
  assert.equal(
    stripPrivateChatRequestNoise('Pufu Lens開発 に関する情報は見つかりますか？'),
    'Pufu Lens開発 は見つかりますか',
  );
  assert.equal(stripPrivateChatRequestNoise('API設計に関する資料をください。'), 'API設計 資料');
  assert.equal(
    stripPrivateChatRequestNoise('認証フロー 関連する情報を教えてください'),
    '認証フロー',
  );
});

test('resolvePrivateChatRetryQueries adds simplified retry when no scored vector candidate survives', () => {
  const plan = buildPrivateChatSearchQueryPlan('プロジェクト概要 最新 更新 状況 教えてください');
  assert.deepEqual(
    resolvePrivateChatRetryQueries({
      mergedVectorSources: [],
      plan,
    }),
    [plan.simplifiedRetryQuery],
  );
  assert.equal(plan.simplifiedRetryQuery, 'プロジェクト概要 最新');
  assert.equal(
    shouldRunPrivateChatRetryStep({
      mergedVectorSources: [sampleSource],
      plan,
    }),
    true,
  );
});

test('runPrivateChatSearchRetrieval always performs vector search and graph query', async () => {
  const vectorSearchInputs: string[] = [];
  const graphQueryCalls: number[] = [];
  const timelineSearchCalls: number[] = [];
  const repository = {
    async documentFetch() {
      return [sampleSource];
    },
    async graphQuery() {
      graphQueryCalls.push(1);
      return [{ ...sampleSource, documentId: 'doc-graph' }];
    },
    async timelineSearch() {
      timelineSearchCalls.push(1);
      return [{ ...sampleSource, documentId: 'doc-timeline' }];
    },
    async vectorSearch({ query }: { query: string }) {
      vectorSearchInputs.push(query);
      return [{ ...sampleSource, vectorDistance: 0.2 }];
    },
  };

  await runPrivateChatSearchRetrieval({
    embeddingProvider: testEmbeddingProvider,
    graphName: 'graph-a',
    projectId: 'project-a',
    question: '最近の進捗は？',
    repository: repository as never,
  });

  assert.equal(vectorSearchInputs.length, 1);
  assert.equal(graphQueryCalls.length, 1);
  assert.equal(timelineSearchCalls.length, 0);
});

test('runPrivateChatSearchRetrieval runs timeline for deterministic timeline fallback', async () => {
  const stages: string[] = [];
  const vectorSearchInputs: string[] = [];
  const timelineSearchCalls: number[] = [];
  const repository = {
    async documentFetch() {
      return [sampleSource];
    },
    async graphQuery() {
      return [{ ...sampleSource, documentId: 'doc-graph' }];
    },
    async timelineSearch() {
      timelineSearchCalls.push(1);
      return [{ ...sampleSource, documentId: 'doc-timeline' }];
    },
    async vectorSearch({ query }: { query: string }) {
      vectorSearchInputs.push(query);
      return [{ ...sampleSource, vectorDistance: 0.2 }];
    },
  };

  await runPrivateChatSearchRetrieval({
    embeddingProvider: testEmbeddingProvider,
    graphName: 'graph-a',
    onStage: (stage) => {
      stages.push(stage);
    },
    projectId: 'project-a',
    question: '障害対応の経緯と時系列を教えて',
    repository: repository as never,
  });

  assert.equal(vectorSearchInputs.length, 1);
  assert.equal(timelineSearchCalls.length, 1);
  assert.ok(!stages.includes('retrying'));
  assert.ok(stages.includes('timeline'));
  assert.equal(inferChatEditingMetadata('障害対応の経緯と時系列を教えて').inferredMode, 'timeline');
});

test('runPrivateChatRetryingStep batches embeddings and fuses concurrent variant rankings', async () => {
  const state = applyPrivateChatWorkflowQueryExpansion(
    runPrivateChatPreparingStep({
      graphName: 'graph-a',
      projectId: 'project-a',
      question: 'pufu-editorでのエラー対応実績教えてください',
    }),
    {
      queries: [
        { operation: 'cause', purpose: '原因', query: 'pufu-editor エラー 原因' },
        { operation: 'process', purpose: '修正', query: 'pufu-editor fix' },
      ],
    },
  );
  let activeSearches = 0;
  let maxActiveSearches = 0;
  const embeddingBatches: string[][] = [];
  const batchingEmbeddingProvider: ChatEmbeddingProvider = {
    ...testEmbeddingProvider,
    async embedTexts(texts) {
      embeddingBatches.push([...texts]);
      return testEmbeddingProvider.embedTexts(texts);
    },
  };
  const result = await runPrivateChatRetryingStep(
    state,
    {
      async vectorSearch({ query }: { query: string }) {
        activeSearches += 1;
        maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
        await new Promise<void>((resolve) => setTimeout(resolve, query.includes('fix') ? 5 : 10));
        activeSearches -= 1;
        return [{ ...sampleSource, documentId: `doc-${query}` }];
      },
    } as never,
    batchingEmbeddingProvider,
  );
  assert.ok(maxActiveSearches > 1);
  assert.deepEqual(embeddingBatches, [state.plan.expandedQueries.map(({ query }) => query)]);
  assert.deepEqual(
    result.mergedVectorSources.map((source) => source.documentId),
    state.plan.expandedQueries.map(({ query }) => `doc-${query}`),
  );
});

test('runPrivateChatDetailStep keeps richer fetched sources for duplicate document IDs', async () => {
  const originalSource = { ...sampleSource, documentId: 'doc-a', snippet: '検索結果の概要' };
  const detailSource = { ...sampleSource, documentId: 'doc-a', snippet: '取得した詳細情報' };
  const state = {
    ...runPrivateChatPreparingStep({
      graphName: 'graph-a',
      projectId: 'project-a',
      question: 'プロジェクト概要',
    }),
    mergedVectorSources: [originalSource],
  };

  const result = await runPrivateChatDetailStep(state, {
    async documentFetch() {
      return [detailSource];
    },
  } as never);

  assert.equal(result.sources[0]?.snippet, detailSource.snippet);
  assert.ok(result.retrievalContext.includes(detailSource.snippet));
  assert.ok(!result.retrievalContext.includes(originalSource.snippet));
});

test('runPrivateChatDetailStep excludes blank document IDs from detail fetch', async () => {
  const fetchedDocumentIds: Array<readonly string[]> = [];
  const state = {
    ...runPrivateChatPreparingStep({
      graphName: 'graph-a',
      projectId: 'project-a',
      question: 'プロジェクト概要',
    }),
    mergedVectorSources: [
      { ...sampleSource, documentId: '', rawDocumentId: 'raw-empty' },
      { ...sampleSource, documentId: '   ', rawDocumentId: 'raw-blank' },
      { ...sampleSource, documentId: 'doc-valid' },
    ],
  };

  await runPrivateChatDetailStep(state, {
    async documentFetch({ documentIds }: { documentIds: readonly string[] }) {
      fetchedDocumentIds.push(documentIds);
      return [];
    },
  } as never);

  assert.deepEqual(fetchedDocumentIds, [['doc-valid']]);
});

test('runPrivateChatSearchRetrieval runs one simplified retry when neutral primary search returns zero', async () => {
  const vectorSearchInputs: string[] = [];
  const stages: string[] = [];
  const plan = buildPrivateChatSearchQueryPlan('プロジェクト概要 最新 更新 状況 教えてください');
  const repository = {
    async documentFetch() {
      return [];
    },
    async graphQuery() {
      return [];
    },
    async timelineSearch() {
      return [];
    },
    async vectorSearch({ query }: { query: string }) {
      vectorSearchInputs.push(query);
      return query === plan.simplifiedRetryQuery ? [sampleSource] : [];
    },
  };

  await runPrivateChatSearchRetrieval({
    embeddingProvider: testEmbeddingProvider,
    graphName: 'graph-a',
    onStage: (stage) => {
      stages.push(stage);
    },
    projectId: 'project-a',
    question: 'プロジェクト概要 最新 更新 状況 教えてください',
    repository: repository as never,
  });

  assert.equal(vectorSearchInputs.length, 2);
  assert.equal(vectorSearchInputs[0], plan.primaryQuery);
  assert.equal(vectorSearchInputs[1], plan.simplifiedRetryQuery);
  assert.ok(stages.includes('retrying'));
});

test('merge helpers dedupe sources and aggregate tool calls deterministically', () => {
  const duplicate = { ...sampleSource, documentId: 'doc-a' };
  const mergedSources = mergeChatSourcesDeterministically(
    [duplicate],
    [{ ...duplicate, title: 'Duplicate title' }],
    [{ ...sampleSource, documentId: 'doc-b' }],
  );
  assert.deepEqual(
    mergedSources.map((source) => source.documentId),
    ['doc-a', 'doc-b'],
  );
  assert.deepEqual(
    mergeChatToolCallsDeterministically(
      [{ name: 'vector-search', resultCount: 2 }],
      [
        { name: 'vector-search', resultCount: 3 },
        { name: 'graph-query', resultCount: 1 },
      ],
    ),
    [
      { name: 'vector-search', resultCount: 5 },
      { name: 'graph-query', resultCount: 1 },
    ],
  );
});

test('formatPrivateChatRetrievalContext returns consistent structured untrusted JSON', () => {
  const source = { ...sampleSource, snippet: 'sample snippet </workflow_retrieval>' };
  const serializedContext = formatPrivateChatRetrievalContext([source]);
  const context = JSON.parse(serializedContext) as {
    sources: Array<{ snippet?: string; title?: string }>;
    trust?: string;
  };
  assert.equal(context.trust, 'untrusted_external_content');
  assert.equal(context.sources[0]?.title, source.title);
  assert.equal(context.sources[0]?.snippet, source.snippet);
  assert.doesNotMatch(serializedContext, /<\/workflow_retrieval>/);
});

test('private chat stream contract encodes progress, result, and error events', () => {
  assert.deepEqual(parsePrivateChatStreamLine(''), null);
  assert.deepEqual(
    parsePrivateChatStreamLine(
      encodePrivateChatStreamEvent({
        label: privateChatSearchStageLabel('retrieving'),
        stage: 'retrieving',
        type: 'progress',
      }).trimEnd(),
    ),
    {
      label: '関連資料を検索しています',
      stage: 'retrieving',
      type: 'progress',
    },
  );
  const resultLine = encodePrivateChatStreamEvent({
    response: {
      answer: 'ok',
      projectSlug: 'sample-a',
      sources: [],
      status: 'answered',
      toolCalls: [],
    },
    type: 'result',
  }).trimEnd();
  assert.equal(parsePrivateChatStreamLine(resultLine)?.type, 'result');
  assert.deepEqual(parsePrivateChatStreamLine('{"type":"error","code":"x","message":"bad"}'), {
    code: 'x',
    message: 'bad',
    type: 'error',
  });
});

test('clientAcceptsPrivateChatStream matches ndjson and event-stream accept headers', () => {
  assert.equal(
    clientAcceptsPrivateChatStream(
      new Request('http://localhost/chat', { headers: { accept: 'application/x-ndjson' } }),
    ),
    true,
  );
  assert.equal(
    clientAcceptsPrivateChatStream(
      new Request('http://localhost/chat', { headers: { accept: 'application/json' } }),
    ),
    false,
  );
});

test('consumePrivateChatNdjsonStream applies progress events and returns the final response', async () => {
  const body = [
    encodePrivateChatStreamEvent({
      label: privateChatSearchStageLabel('retrieving'),
      stage: 'retrieving',
      type: 'progress',
    }),
    encodePrivateChatStreamEvent({
      response: {
        answer: 'stream answer',
        projectSlug: 'sample-a',
        sources: [],
        status: 'answered',
        toolCalls: [{ name: 'vector-search', resultCount: 1 }],
      },
      type: 'result',
    }),
  ].join('');
  const progressLabels: string[] = [];
  const streamResponse = new Response(body, {
    headers: { 'content-type': 'application/x-ndjson' },
  });
  const response = await consumePrivateChatNdjsonStream(streamResponse, (event) => {
    progressLabels.push(event.label);
  });
  assert.deepEqual(progressLabels, ['関連資料を検索しています']);
  assert.equal(response.answer, 'stream answer');
  assert.equal(streamResponse.body?.locked, false);
});

test('consumePrivateChatNdjsonStream rejects an oversized line with a generic error', async () => {
  await assert.rejects(
    consumePrivateChatNdjsonStream(new Response('x'.repeat(17)), undefined, {
      maxBufferBytes: 16,
    }),
    (error: Error) => error.message === PRIVATE_CHAT_NDJSON_STREAM_ERROR_MESSAGE,
  );
});

test('consumePrivateChatNdjsonStream enforces the buffer limit in UTF-8 bytes', async () => {
  await assert.rejects(
    consumePrivateChatNdjsonStream(new Response('ああ'), undefined, {
      maxBufferBytes: 5,
    }),
    (error: Error) => error.message === PRIVATE_CHAT_NDJSON_STREAM_ERROR_MESSAGE,
  );
});

test('parseMastraWorkflowStreamBuffer parses record separator chunks and enforces buffer bound', () => {
  const record = { payload: { id: 'private-chat-retrieving' }, type: 'workflow-step-start' };
  const parsed = parseMastraWorkflowStreamBuffer({
    buffer: `${JSON.stringify(record)}${MASTRA_WORKFLOW_RECORD_SEPARATOR}partial`,
  });
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.remainder, 'partial');
  assert.throws(
    () =>
      parseMastraWorkflowStreamBuffer({
        buffer: 'x'.repeat(MAX_MASTRA_WORKFLOW_STREAM_BUFFER_BYTES + 1),
      }),
    (error: Error & { reason?: string; status?: number }) =>
      error.reason === 'malformed_or_oversized_stream' && error.status === 502,
  );
});

test('consumeMastraWorkflowStreamText maps workflow steps to UI stages and extracts final ChatResponse', () => {
  const chatResponse = {
    answer: 'workflow answer',
    projectSlug: 'sample-a',
    sources: [],
    status: 'answered' as const,
    toolCalls: [{ name: 'vector-search', resultCount: 1 }],
  };
  const streamText = [
    { payload: { id: 'private-chat-preparing' }, type: 'workflow-step-start' },
    { payload: { id: 'private-chat-classifying' }, type: 'workflow-step-start' },
    { payload: { id: 'private-chat-expanding' }, type: 'workflow-step-start' },
    { payload: { id: 'private-chat-retrieving' }, type: 'workflow-step-start' },
    {
      payload: { id: 'private-chat-synthesis', output: chatResponse },
      type: 'workflow-step-result',
    },
  ]
    .map((record) => JSON.stringify(record))
    .join(MASTRA_WORKFLOW_RECORD_SEPARATOR);
  const stages: string[] = [];
  const response = consumeMastraWorkflowStreamText(streamText, (record) => {
    const stage = mapMastraWorkflowRecordToUiStage(record);
    if (stage) {
      stages.push(stage);
    }
  });
  assert.deepEqual(stages, ['preparing', 'classifying', 'expanding', 'retrieving']);
  assert.equal(privateChatSearchStageLabel('classifying'), '質問の見方を整理しています');
  assert.equal(privateChatSearchStageLabel('expanding'), '検索語を展開しています');
  assert.equal(response.answer, 'workflow answer');
});

test('runPrivateChatSearchViaMastraWorkflow uses workflow create-run and stream endpoints only', async () => {
  const requestedUrls: string[] = [];
  const chatResponse = {
    answer: 'workflow answer',
    projectSlug: 'sample-a',
    sources: [sampleSource],
    status: 'answered' as const,
    toolCalls: [{ name: 'vector-search', resultCount: 1 }],
  };
  const streamBody = [
    {
      payload: { id: 'private-chat-synthesis', output: chatResponse },
      type: 'workflow-step-result',
    },
  ]
    .map((record) => JSON.stringify(record))
    .join(MASTRA_WORKFLOW_RECORD_SEPARATOR);

  const response = await runPrivateChatSearchViaMastraWorkflow({
    env: { MASTRA_SERVER_URL: 'http://127.0.0.1:4111' },
    fetchImpl: async (url, init) => {
      requestedUrls.push(String(url));
      if (String(url).endsWith('/api/workflows/private-chat-search/create-run')) {
        assert.equal(init?.method, 'POST');
        return new Response(JSON.stringify({ runId: 'run-test-1' }), { status: 200 });
      }
      if (String(url).includes('/api/workflows/private-chat-search/stream?runId=run-test-1')) {
        assert.equal(init?.method, 'POST');
        const body = JSON.parse(String(init?.body)) as { inputData?: { question?: string } };
        assert.equal(body.inputData?.question, 'error fix の状況は？');
        return new Response(streamBody, { status: 200 });
      }
      if (String(url).includes('/api/agents/project-chat-agent/generate')) {
        throw new Error('private chat must not call agent generate directly');
      }
      return new Response('not found', { status: 404 });
    },
    graphName: 'graph-a',
    history: [],
    projectId: 'project-a',
    projectSlug: 'sample-a',
    question: 'error fix の状況は？',
  });

  assert.equal(
    mastraPrivateChatSearchCreateRunUrl({ MASTRA_SERVER_URL: 'http://127.0.0.1:4111' }),
    'http://127.0.0.1:4111/api/workflows/private-chat-search/create-run',
  );
  assert.equal(
    mastraPrivateChatSearchStreamUrl('run-test-1', { MASTRA_SERVER_URL: 'http://127.0.0.1:4111' }),
    'http://127.0.0.1:4111/api/workflows/private-chat-search/stream?runId=run-test-1',
  );
  assert.ok(
    requestedUrls.every(
      (url) =>
        url.includes('/api/workflows/private-chat-search/') &&
        !url.includes('/api/agents/project-chat-agent/generate'),
    ),
  );
  assert.equal(response.answer, 'workflow answer');
});

test('workflow stream errors surface a generic Japanese message to callers', () => {
  assert.throws(
    () =>
      consumeMastraWorkflowStreamText(
        `${JSON.stringify({ type: 'error', payload: { message: 'upstream secret body' } })}${MASTRA_WORKFLOW_RECORD_SEPARATOR}`,
      ),
    (error: Error) => error.message === PRIVATE_CHAT_STREAM_USER_ERROR_MESSAGE,
  );
});

test('workflow HTTP failures never retain or log the upstream response body', async () => {
  const secretBody = 'UPSTREAM_SECRET_BODY oauth_token=secret';
  let responseBodyCanceled = false;
  let caught: unknown;
  try {
    await runPrivateChatSearchViaMastraWorkflow({
      env: { MASTRA_SERVER_URL: 'http://127.0.0.1:4111' },
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              responseBodyCanceled = true;
            },
            start(controller) {
              controller.enqueue(new TextEncoder().encode(secretBody));
            },
          }),
          { status: 502 },
        ),
      graphName: 'graph-a',
      history: [],
      projectId: 'project-a',
      projectSlug: 'sample-a',
      question: '質問',
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  const safeLog = privateChatWorkflowSafeLogMessage(caught);
  assert.match(safeLog, /create_run_http_error/);
  assert.match(safeLog, /HTTP 502/);
  assert.doesNotMatch(safeLog, /UPSTREAM_SECRET_BODY|oauth_token|secret/);
  assert.doesNotMatch(JSON.stringify(caught), /UPSTREAM_SECRET_BODY|oauth_token|secret/);
  assert.equal(responseBodyCanceled, true);
});

test('workflow aborts are recognized and omitted from safe failure logs', () => {
  const abortError = new Error('request aborted');
  abortError.name = 'AbortError';
  assert.equal(isPrivateChatWorkflowAbortError(abortError), true);
  assert.equal(privateChatWorkflowSafeLogMessage(abortError), '');
});

test('mergeHybridChatResponse deduplicates workflow and agent sources', () => {
  const merged = mergeHybridChatResponse({
    agentResponse: {
      answer: 'answer',
      projectSlug: 'sample-a',
      sources: [{ ...sampleSource, documentId: 'doc-agent' }],
      status: 'answered',
      toolCalls: [{ name: 'parsed-doc-fetch', resultCount: 1 }],
    },
    workflowSources: [sampleSource],
    workflowToolCalls: [{ name: 'vector-search', resultCount: 2 }],
  });
  assert.deepEqual(
    merged.sources.map((source) => source.documentId),
    [sampleSource.documentId, 'doc-agent'],
  );
  assert.deepEqual(merged.toolCalls, [
    { name: 'vector-search', resultCount: 2 },
    { name: 'parsed-doc-fetch', resultCount: 1 },
  ]);
});

test('fuseChatSourceRankings promotes consensus while preserving deterministic ties', () => {
  const docA = { ...sampleSource, documentId: 'doc-a' };
  const docB = { ...sampleSource, documentId: 'doc-b' };
  const docC = { ...sampleSource, documentId: 'doc-c' };
  const fused = fuseChatSourceRankings([
    { sources: [docA, docB], weight: 2 },
    { sources: [docB, docC] },
    { sources: [docB, docA] },
  ]);
  assert.deepEqual(
    fused.map((source) => source.documentId),
    ['doc-b', 'doc-a', 'doc-c'],
  );
  assert.ok((fused[0]?.fusedScore ?? 0) > (fused[1]?.fusedScore ?? 0));
  assert.ok((fused[0]?.fusedScore ?? 2) <= 1);
});
