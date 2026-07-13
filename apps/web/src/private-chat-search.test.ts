import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deterministicVector,
  inferChatEditingMetadata,
  PRIVATE_CHAT_VECTOR_DIMENSIONS,
} from './chat.ts';
import { mergeHybridChatResponse } from './mastra-chat.ts';
import {
  buildPrivateChatSearchQueryPlan,
  formatPrivateChatRetrievalContext,
  MAX_PRIVATE_CHAT_SEARCH_QUERY_VARIANTS,
  mergeChatSourcesDeterministically,
  mergeChatToolCallsDeterministically,
  privateChatSearchStageLabel,
  resolvePrivateChatRetryQueries,
  runPrivateChatPreparingStep,
  runPrivateChatRetryingStep,
  runPrivateChatSearchRetrieval,
  shouldRunPrivateChatRetryStep,
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

test('buildPrivateChatSearchQueryPlan shortens error-related questions into bounded variants', () => {
  const plan = buildPrivateChatSearchQueryPlan('pufu-editorでのエラー対応実績教えてください');
  assert.ok(plan.primaryQuery.length < 'pufu-editorでのエラー対応実績教えてください'.length);
  assert.ok(plan.primaryQuery.includes('pufu-editor'));
  assert.ok(plan.primaryQuery.includes('エラー') || plan.primaryQuery.includes('error'));
  assert.ok(plan.retryQueries.length >= 1);
  assert.ok(plan.retryQueries.length <= MAX_PRIVATE_CHAT_SEARCH_QUERY_VARIANTS - 1);
  for (const query of [plan.primaryQuery, ...plan.retryQueries]) {
    assert.ok(!query.includes('教えてください'));
    assert.ok(!query.includes('対応実績'));
  }
  assert.ok(
    plan.retryQueries.some(
      (query) =>
        query.includes('修正') ||
        query.includes('fix') ||
        query.includes('bug') ||
        query.includes('failure'),
    ),
  );
});

test('buildPrivateChatSearchQueryPlan keeps neutral questions short and enables simplified retry', () => {
  const plan = buildPrivateChatSearchQueryPlan('プロジェクト概要を教えて');
  assert.equal(plan.primaryQuery, 'プロジェクト概要');
  assert.deepEqual(plan.retryQueries, []);
  assert.equal(plan.simplifiedRetryQuery, null);
});

test('stripPrivateChatRequestNoise removes request phrases while preserving entity tokens', () => {
  assert.equal(
    stripPrivateChatRequestNoise('pufu-editorでのエラー対応実績教えてください'),
    'pufu-editor エラー',
  );
});

test('resolvePrivateChatRetryQueries adds simplified retry only for neutral zero-result searches', () => {
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
    false,
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
      return [sampleSource];
    },
  };

  await runPrivateChatSearchRetrieval({
    graphName: 'graph-a',
    projectId: 'project-a',
    question: '最近の進捗は？',
    repository: repository as never,
  });

  assert.equal(vectorSearchInputs.length, 1);
  assert.equal(graphQueryCalls.length, 1);
  assert.equal(timelineSearchCalls.length, 0);
});

test('runPrivateChatSearchRetrieval retries with expanded queries and runs timeline for timeline mode', async () => {
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
      return [sampleSource];
    },
  };

  await runPrivateChatSearchRetrieval({
    graphName: 'graph-a',
    onStage: (stage) => {
      stages.push(stage);
    },
    projectId: 'project-a',
    question: '障害対応の経緯と時系列を教えて',
    repository: repository as never,
  });

  assert.ok(vectorSearchInputs.length >= 2);
  assert.equal(timelineSearchCalls.length, 1);
  assert.ok(stages.includes('retrying'));
  assert.ok(stages.includes('timeline'));
  assert.equal(inferChatEditingMetadata('障害対応の経緯と時系列を教えて').inferredMode, 'timeline');
});

test('runPrivateChatRetryingStep searches variants concurrently and merges in plan order', async () => {
  const state = runPrivateChatPreparingStep({
    graphName: 'graph-a',
    projectId: 'project-a',
    question: 'pufu-editorでのエラー対応実績教えてください',
  });
  let activeSearches = 0;
  let maxActiveSearches = 0;
  const result = await runPrivateChatRetryingStep(state, {
    async vectorSearch({ query }: { query: string }) {
      activeSearches += 1;
      maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
      await new Promise<void>((resolve) => setTimeout(resolve, query.includes('fix') ? 5 : 10));
      activeSearches -= 1;
      return [{ ...sampleSource, documentId: `doc-${query}` }];
    },
  } as never);
  assert.ok(maxActiveSearches > 1);
  assert.deepEqual(
    result.mergedVectorSources.map((source) => source.documentId),
    state.plan.retryQueries.map((query) => `doc-${query}`),
  );
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
    /buffer exceeded/,
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
  assert.deepEqual(stages, ['preparing', 'retrieving']);
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

test('deterministicVector remains stable for expanded private chat queries', () => {
  const primary = deterministicVector('障害 error', PRIVATE_CHAT_VECTOR_DIMENSIONS);
  const expanded = deterministicVector('障害 error fix', PRIVATE_CHAT_VECTOR_DIMENSIONS);
  assert.equal(primary.length, PRIVATE_CHAT_VECTOR_DIMENSIONS);
  assert.equal(expanded.length, PRIVATE_CHAT_VECTOR_DIMENSIONS);
  assert.notDeepEqual(primary, expanded);
});
