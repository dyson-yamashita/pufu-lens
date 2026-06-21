import assert from 'node:assert/strict';
import { createCredentialsRateLimiter, credentialsRateLimitKey } from './credentials-rate-limit.ts';

const limiter = createCredentialsRateLimiter({ limit: 2, windowMs: 1_000 });

assert.deepEqual(limiter.check('owner@example.com', 1_000), { allowed: true, retryAfterMs: 0 });
limiter.recordFailure('owner@example.com', 1_000);
assert.deepEqual(limiter.check('owner@example.com', 1_100), { allowed: true, retryAfterMs: 0 });
limiter.recordFailure('owner@example.com', 1_100);
assert.deepEqual(limiter.check('owner@example.com', 1_200), {
  allowed: false,
  retryAfterMs: 800,
});

limiter.reset('owner@example.com');
assert.deepEqual(limiter.check('owner@example.com', 1_300), { allowed: true, retryAfterMs: 0 });

limiter.recordFailure('member@example.com', 2_000);
limiter.recordFailure('member@example.com', 2_100);
assert.deepEqual(limiter.check('member@example.com', 3_000), { allowed: true, retryAfterMs: 0 });

assert.equal(credentialsRateLimitKey(' OWNER@Example.COM '), 'owner@example.com');
assert.equal(credentialsRateLimitKey('   '), 'anonymous');

console.log('web credentials rate limit tests passed');
