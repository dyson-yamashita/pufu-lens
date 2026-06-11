import assert from 'node:assert/strict';
import { createPublicChatMemoryRateLimiter } from './chat.ts';
import { trustedClientIp } from './request-client.ts';

function requestHeaders(headers: Record<string, string>) {
  return new Headers(headers);
}

assert.equal(
  trustedClientIp(requestHeaders({ 'x-forwarded-for': '203.0.113.10, 10.0.0.1' })),
  '10.0.0.1',
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

console.log('web public report api tests passed');
