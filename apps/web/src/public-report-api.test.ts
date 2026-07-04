import assert from 'node:assert/strict';
import { createPublicChatMemoryRateLimiter, inferChatEditingMetadata } from './chat.ts';
import {
  createPublicProjectChatMastraBody,
  LEGACY_PUBLIC_REPORT_CHAT_AGENT_ID,
  mastraProjectChatGenerateUrl,
  PUBLIC_PROJECT_CHAT_AGENT_ID,
} from './mastra-chat.ts';
import { trustedClientIp } from './request-client.ts';

function requestHeaders(headers: Record<string, string>) {
  return new Headers(headers);
}

assert.equal(
  trustedClientIp(requestHeaders({ 'x-forwarded-for': '203.0.113.10, 198.51.100.20' })),
  '198.51.100.20',
);
assert.equal(
  trustedClientIp(requestHeaders({ 'x-forwarded-for': '203.0.113.10, 10.0.0.1' })),
  '203.0.113.10',
);
assert.equal(trustedClientIp(requestHeaders({ 'x-real-ip': '203.0.113.20' })), '203.0.113.20');
assert.equal(
  trustedClientIp(requestHeaders({ 'x-forwarded-for': 'unknown', 'x-real-ip': '203.0.113.30' })),
  '203.0.113.30',
);
assert.equal(trustedClientIp(requestHeaders({})), 'anonymous');

const limiter = createPublicChatMemoryRateLimiter({
  limit: 1,
  now: () => 1_000,
  windowMs: 60_000,
});
assert.equal(limiter.check({ clientIp: '203.0.113.10', reportId: 'report-a' }), true);
assert.equal(limiter.check({ clientIp: '203.0.113.10', reportId: 'report-a' }), false);
assert.equal(limiter.check({ clientIp: '203.0.113.11', reportId: 'report-a' }), true);

assert.deepEqual(
  createPublicProjectChatMastraBody({
    project: { graphName: 'graph_sample_a', id: 'project-a' },
    question: '公開 project の進捗は?',
  }),
  {
    messages: [{ content: '公開 project の進捗は?', role: 'user' }],
    requestContext: {
      editing: inferChatEditingMetadata('公開 project の進捗は?'),
      graphName: 'graph_sample_a',
      projectId: 'project-a',
    },
  },
);
assert.equal(
  new URL(mastraProjectChatGenerateUrl({ MASTRA_SERVER_URL: 'http://localhost:4111/' })).pathname,
  `/api/agents/${PUBLIC_PROJECT_CHAT_AGENT_ID}/generate`,
);
assert.notEqual(PUBLIC_PROJECT_CHAT_AGENT_ID, LEGACY_PUBLIC_REPORT_CHAT_AGENT_ID);

console.log('web public report api tests passed');
