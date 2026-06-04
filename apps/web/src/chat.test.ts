import assert from 'node:assert/strict';
import {
  type ChatRepository,
  chatNowFromEnv,
  createExtractiveChatProvider,
  createGeminiChatProvider,
  createMemoryRateLimiter,
  isWithinBusinessHours,
  ProjectAccessDeniedError,
  runPrivateChat,
} from './chat.ts';

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
      return projectSlug === 'sample-a' && userId === 'user-a'
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
assert.throws(
  () => chatNowFromEnv({ ...process.env, PUFU_LENS_CHAT_NOW: 'invalid-date' }),
  /PUFU_LENS_CHAT_NOW must be an ISO 8601 datetime/,
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

console.log('web chat tests passed');
