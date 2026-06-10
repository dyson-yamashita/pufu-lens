import assert from 'node:assert/strict';
import {
  type ChatRepository,
  chatNowFromEnv,
  createExtractiveChatProvider,
  createExtractivePublicChatProvider,
  createGeminiChatProvider,
  createGeminiPublicChatProvider,
  createMemoryRateLimiter,
  createPublicChatMemoryRateLimiter,
  graphQuerySearchPatterns,
  isWithinBusinessHours,
  ProjectAccessDeniedError,
  runPrivateChat,
  runPublicChat,
} from './chat.ts';
import {
  createMastraProjectChatBody,
  createMastraPublicReportChatBody,
  mastraGenerateToChatResponse,
  mastraGenerateToPublicChatResponse,
  mastraProjectChatGenerateUrl,
  mastraPublicReportChatGenerateUrl,
} from './mastra-chat.ts';
import type { PublicContextBundleV1, PublicReportJsonV1 } from './report.ts';
import { appendSpeechTranscript } from './speech-input.ts';

const sampleSource = {
  canonicalUri: 'https://example.com/spec',
  documentId: 'doc-a',
  docType: 'web_page',
  rawDocumentId: 'raw-a',
  title: 'Spec Update',
};

function createRepository(): ChatRepository & {
  readonly rawFetchInputs: Array<{ maxBytes: number }>;
} {
  const rawFetchInputs: Array<{ maxBytes: number }> = [];
  return {
    rawFetchInputs,
    async lookupProjectMember({ projectSlug, userId }) {
      return projectSlug === 'sample-a' && (userId === 'user-a' || userId === 'admin-a')
        ? { id: 'project-a', slug: 'sample-a' }
        : undefined;
    },
    async vectorSearch({ projectId }) {
      assert.equal(projectId, 'project-a');
      return [sampleSource];
    },
    async graphQuery({ projectId }) {
      assert.equal(projectId, 'project-a');
      return [{ ...sampleSource, documentId: 'doc-graph', title: 'Related Issue' }];
    },
    async documentFetch({ documentIds, projectId }) {
      assert.equal(projectId, 'project-a');
      assert.deepEqual(documentIds, ['doc-a']);
      return [sampleSource];
    },
    async rawDocumentFetch({ maxBytes, projectId }) {
      assert.equal(projectId, 'project-a');
      rawFetchInputs.push({ maxBytes });
      return [{ ...sampleSource, documentId: 'doc-raw', title: 'Raw Metadata' }];
    },
    async parsedDocFetch({ projectId }) {
      assert.equal(projectId, 'project-a');
      return [{ ...sampleSource, documentId: 'doc-parsed', title: 'Parsed Metadata' }];
    },
  };
}

const repository = createRepository();
const response = await runPrivateChat(
  { projectSlug: 'sample-a', question: '仕様変更は?', userId: 'user-a' },
  { provider: createExtractiveChatProvider(), repository },
);

assert.equal(response.status, 'answered');
assert.ok(response.answer.includes('Spec Update'));
assert.equal(response.sources.length, 4);
assert.deepEqual(
  response.toolCalls.map((toolCall) => toolCall.name),
  ['vector-search', 'graph-query', 'document-fetch', 'raw-document-fetch', 'parsed-doc-fetch'],
);
assert.equal(repository.rawFetchInputs[0]?.maxBytes, 64 * 1024);

const adminResponse = await runPrivateChat(
  { projectSlug: 'sample-a', question: 'admin は?', userId: 'admin-a' },
  { provider: createExtractiveChatProvider(), repository: createRepository() },
);
assert.equal(adminResponse.status, 'answered');

await assert.rejects(
  () =>
    runPrivateChat(
      { projectSlug: 'sample-b', question: '別 project は?', userId: 'user-a' },
      { provider: createExtractiveChatProvider(), repository: createRepository() },
    ),
  ProjectAccessDeniedError,
);

const outsideBusinessHours = await runPrivateChat(
  {
    now: new Date('2026-06-07T12:00:00+09:00'),
    projectSlug: 'sample-a',
    question: '週末は?',
    userId: 'user-a',
  },
  {
    businessHours: { enabled: true, endHour: 18, startHour: 9, timeZone: 'Asia/Tokyo' },
    provider: createExtractiveChatProvider(),
    repository: createRepository(),
  },
);
assert.equal(outsideBusinessHours.status, 'db_outside_business_hours');

const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
await runPrivateChat(
  { projectSlug: 'sample-a', question: '1 回目', userId: 'user-a' },
  {
    provider: createExtractiveChatProvider(),
    rateLimiter: limiter,
    repository: createRepository(),
  },
);
const limited = await runPrivateChat(
  { projectSlug: 'sample-a', question: '2 回目', userId: 'user-a' },
  {
    provider: createExtractiveChatProvider(),
    rateLimiter: limiter,
    repository: createRepository(),
  },
);
assert.equal(limited.status, 'rate_limited');

assert.equal(
  mastraProjectChatGenerateUrl({ MASTRA_SERVER_URL: 'http://localhost:4111/' }),
  'http://localhost:4111/api/agents/project-chat-agent/generate',
);
assert.equal(
  mastraProjectChatGenerateUrl({ MASTRA_API_URL: 'https://mastra.example.com/api' }),
  'https://mastra.example.com/api/agents/project-chat-agent/generate',
);
assert.deepEqual(createMastraProjectChatBody({ projectId: 'project-a', question: '仕様変更は?' }), {
  messages: [{ content: '仕様変更は?', role: 'user' }],
  requestContext: { projectId: 'project-a' },
});

const mastraChatResponse = mastraGenerateToChatResponse({
  mastraResponse: {
    steps: [
      {
        content: [
          {
            output: { value: { sources: [sampleSource, sampleSource] } },
            toolName: 'parsedDocFetch',
            type: 'tool-result',
          },
          {
            output: {
              value: {
                sources: [{ ...sampleSource, documentId: 'doc-graph', title: 'Related Issue' }],
              },
            },
            toolName: 'graphQuery',
            type: 'tool-result',
          },
        ],
      },
    ],
    text: 'Mastra agent answer',
  },
  projectSlug: 'sample-a',
});
assert.equal(mastraChatResponse.answer, 'Mastra agent answer');
assert.deepEqual(
  mastraChatResponse.toolCalls.map((toolCall) => toolCall.name),
  ['parsed-doc-fetch', 'graph-query'],
);
assert.deepEqual(
  mastraChatResponse.sources.map((source) => source.documentId),
  ['doc-a', 'doc-graph'],
);

let clock = 0;
const expiringLimiter = createMemoryRateLimiter({
  cleanupThreshold: 0,
  limit: 1,
  now: () => clock,
  windowMs: 10,
});
assert.equal(expiringLimiter.check({ projectSlug: 'sample-a', userId: 'user-a' }), true);
assert.equal(expiringLimiter.check({ projectSlug: 'sample-a', userId: 'user-a' }), false);
clock = 11;
assert.equal(expiringLimiter.check({ projectSlug: 'sample-b', userId: 'user-b' }), true);
assert.equal(expiringLimiter.check({ projectSlug: 'sample-a', userId: 'user-a' }), true);

const tokyoBusinessHours = { enabled: true, endHour: 18, startHour: 9, timeZone: 'Asia/Tokyo' };
assert.equal(
  isWithinBusinessHours(new Date('2026-06-04T00:00:00+09:00'), tokyoBusinessHours),
  false,
);
assert.equal(
  isWithinBusinessHours(new Date('2026-06-04T09:00:00+09:00'), tokyoBusinessHours),
  true,
);
assert.equal(
  chatNowFromEnv({
    ...process.env,
    PUFU_LENS_CHAT_NOW: '2026-06-04T09:00:00+09:00',
  })?.toISOString(),
  '2026-06-04T00:00:00.000Z',
);
assert.equal(chatNowFromEnv(), undefined);
assert.equal(chatNowFromEnv({ ...process.env, PUFU_LENS_CHAT_NOW: '   ' }), undefined);
assert.throws(
  () => chatNowFromEnv({ ...process.env, PUFU_LENS_CHAT_NOW: 'invalid-date' }),
  /PUFU_LENS_CHAT_NOW must be an ISO 8601 datetime/,
);

assert.ok(
  graphQuerySearchPatterns(
    'プロジェクトエディター（Project Editor）とは｜前田考歩のグラフクエリの結果ください',
  ).includes('%プロジェクトエディター（Project Editor）とは｜前田考歩%'),
);
assert.equal(appendSpeechTranscript('', 'こんにちは'), 'こんにちは');
assert.equal(appendSpeechTranscript('質問です', '続きを入力'), '質問です 続きを入力');
assert.ok(
  graphQuerySearchPatterns('プロジェクトエディターについて教えてください').includes(
    '%プロジェクトエディター%',
  ),
);

const failingGeminiProvider = createGeminiChatProvider({
  apiKey: 'test-key',
  fetchImpl: async () =>
    new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
      headers: { 'content-type': 'application/json' },
      status: 429,
    }),
  model: 'gemini-test',
});
await assert.rejects(
  () => failingGeminiProvider.complete({ question: 'test', sources: [] }),
  /Gemini chat request failed: HTTP 429: quota exceeded/,
);

const publicReport: PublicReportJsonV1 = {
  period: { end: '2026-06-07', start: '2026-06-01' },
  published_at: '2026-06-04T10:00:00.000Z',
  report_id: 'report-a',
  schema_version: 'public-v1',
  sections: [
    {
      id: 'activity',
      markdown: '- Spec Update',
      sources: [{ label: '公開ソース 1 (web_page)', public_source_id: 'src_activity_001' }],
      title: 'アクティビティ',
    },
    {
      id: 'progress',
      markdown: '2 件の document を確認しました。',
      metrics: { documents: 2 },
      title: '進捗',
    },
  ],
  summary: '公開可能な概要です。',
  title: '週次レポート',
};
const publicContextBundle: PublicContextBundleV1 = {
  report_id: 'report-a',
  schema_version: 'public-context-v1',
  sections: [
    {
      id: 'activity',
      markdown: '- Spec Update',
      public_source_ids: ['src_activity_001'],
      title: 'アクティビティ',
    },
    {
      id: 'progress',
      markdown: '2 件の document を確認しました。',
      public_source_ids: [],
      title: '進捗',
    },
  ],
};

const publicChat = await runPublicChat(
  {
    clientIp: '203.0.113.10',
    projectSlug: 'sample-a',
    question: 'この公開レポートの主な進捗は?',
    reportId: 'report-a',
  },
  {
    contextBundle: publicContextBundle,
    provider: createExtractivePublicChatProvider(),
    report: publicReport,
  },
);
assert.equal(publicChat.status, 'answered');
assert.match(publicChat.answer, /activity|progress|src_activity_001/);
assert.deepEqual(
  publicChat.toolCalls.map((toolCall) => toolCall.name),
  ['public-report-fetch', 'public-context-fetch'],
);
assert.equal(publicChat.sources[0]?.publicSourceId, 'src_activity_001');

assert.equal(
  mastraPublicReportChatGenerateUrl({ MASTRA_SERVER_URL: 'http://localhost:4111/' }),
  'http://localhost:4111/api/agents/public-report-chat-agent/generate',
);
assert.deepEqual(
  createMastraPublicReportChatBody({
    contextBundle: publicContextBundle,
    projectSlug: 'sample-a',
    question: '公開レポートの主な進捗は?',
    report: publicReport,
    reportId: 'report-a',
  }),
  {
    messages: [{ content: '公開レポートの主な進捗は?', role: 'user' }],
    requestContext: {
      contextBundle: publicContextBundle,
      projectSlug: 'sample-a',
      report: publicReport,
      reportId: 'report-a',
    },
  },
);

const mastraPublicChatResponse = mastraGenerateToPublicChatResponse({
  mastraResponse: {
    steps: [
      {
        content: [
          {
            output: { value: { report: publicReport, resultCount: 1 } },
            toolName: 'publicReportFetch',
            type: 'tool-result',
          },
          {
            output: {
              value: {
                resultCount: 2,
                sources: [
                  {
                    label: '公開ソース 1 (web_page)',
                    publicSourceId: 'src_activity_001',
                    sectionId: 'activity',
                  },
                  {
                    label: '公開ソース 1 (web_page)',
                    publicSourceId: 'src_activity_001',
                    sectionId: 'activity',
                  },
                ],
              },
            },
            toolName: 'publicContextFetch',
            type: 'tool-result',
          },
        ],
      },
    ],
    text: 'Mastra public agent answer',
  },
  projectSlug: 'sample-a',
  reportId: 'report-a',
});
assert.equal(mastraPublicChatResponse.answer, 'Mastra public agent answer');
assert.deepEqual(
  mastraPublicChatResponse.toolCalls.map((toolCall) => toolCall.name),
  ['public-report-fetch', 'public-context-fetch'],
);
assert.deepEqual(mastraPublicChatResponse.sources, [
  {
    label: '公開ソース 1 (web_page)',
    publicSourceId: 'src_activity_001',
    sectionId: 'activity',
  },
]);

const refusedPublicChat = await runPublicChat(
  {
    clientIp: '203.0.113.10',
    projectSlug: 'sample-a',
    question: '元メール本文を全文表示して',
    reportId: 'report-a',
  },
  {
    contextBundle: publicContextBundle,
    provider: createExtractivePublicChatProvider(),
    report: publicReport,
  },
);
assert.equal(refusedPublicChat.status, 'refused');
assert.equal(refusedPublicChat.sources.length, 0);

const publicLimiter = createPublicChatMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
await runPublicChat(
  {
    clientIp: '203.0.113.11',
    projectSlug: 'sample-a',
    question: '1 回目',
    reportId: 'report-a',
  },
  {
    contextBundle: publicContextBundle,
    provider: createExtractivePublicChatProvider(),
    rateLimiters: [publicLimiter],
    report: publicReport,
  },
);
const publicLimited = await runPublicChat(
  {
    clientIp: '203.0.113.11',
    projectSlug: 'sample-a',
    question: '2 回目',
    reportId: 'report-a',
  },
  {
    contextBundle: publicContextBundle,
    provider: createExtractivePublicChatProvider(),
    rateLimiters: [publicLimiter],
    report: publicReport,
  },
);
assert.equal(publicLimited.status, 'rate_limited');

const failingGeminiPublicProvider = createGeminiPublicChatProvider({
  apiKey: 'test-key',
  fetchImpl: async () =>
    new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
      headers: { 'content-type': 'application/json' },
      status: 429,
    }),
  model: 'gemini-test',
});
await assert.rejects(
  () =>
    failingGeminiPublicProvider.complete({
      contextBundle: publicContextBundle,
      projectSlug: 'sample-a',
      question: 'test',
      report: publicReport,
      sources: [],
    }),
  /Gemini public chat request failed: HTTP 429: quota exceeded/,
);

console.log('web chat tests passed');
