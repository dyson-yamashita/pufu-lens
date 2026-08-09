import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyDeliveryFailure,
  computeHeartbeatLeaseExpiry,
  DISPATCHER_LEASE_MS,
  DISPATCHER_MAX_LEASE_FROM_ATTEMPT_MS,
  isBlockedByOrderingPredecessor,
  parseRetryAfterHeader,
  resolveRetryDelayMs,
  selectNextQueueKind,
} from './dispatcher.ts';

test('classifyDeliveryFailure retries network-like errors and exhausts after five retries', () => {
  assert.deepEqual(classifyDeliveryFailure({ attemptCount: 1, error: { code: 'timeout' } }), {
    kind: 'retry',
    delayMs: 60_000,
  });
  assert.deepEqual(classifyDeliveryFailure({ attemptCount: 5, error: { code: 'timeout' } }), {
    kind: 'retry',
    delayMs: 12 * 60 * 60_000,
  });
  assert.deepEqual(classifyDeliveryFailure({ attemptCount: 6, error: { code: 'timeout' } }), {
    kind: 'retry_exhausted',
  });
  assert.deepEqual(
    classifyDeliveryFailure({ attemptCount: 1, error: { code: 'gone', httpStatus: 410 } }),
    { kind: 'permanent_failure' },
  );
  assert.deepEqual(
    classifyDeliveryFailure({ attemptCount: 1, error: { code: 'bad_request', httpStatus: 400 } }),
    { kind: 'permanent_failure' },
  );
});

test('resolveRetryDelayMs honors bounded Retry-After', () => {
  assert.equal(resolveRetryDelayMs({ attemptCount: 1, retryAfterMs: 30_000 }), 30_000);
  assert.equal(
    resolveRetryDelayMs({ attemptCount: 1, retryAfterMs: 9_999_999_999 }),
    24 * 60 * 60 * 1000,
  );
});

test('computeHeartbeatLeaseExpiry caps extension at 60 minutes from attempt start', () => {
  const attemptLeaseStartedAt = new Date('2026-01-01T00:00:00.000Z');
  const within = computeHeartbeatLeaseExpiry({
    now: new Date(attemptLeaseStartedAt.getTime() + DISPATCHER_MAX_LEASE_FROM_ATTEMPT_MS - 1_000),
    attemptLeaseStartedAt,
  });
  assert.ok(within);
  const capped = computeHeartbeatLeaseExpiry({
    now: new Date(attemptLeaseStartedAt.getTime() + DISPATCHER_MAX_LEASE_FROM_ATTEMPT_MS),
    attemptLeaseStartedAt,
  });
  assert.equal(capped, null);
  assert.equal(DISPATCHER_LEASE_MS, 15 * 60 * 1000);
});

test('ordering predecessor gate blocks or terminalizes successors', () => {
  assert.equal(
    isBlockedByOrderingPredecessor({
      hasOlderIncompletePredecessor: false,
      predecessorTerminalFailure: false,
    }),
    'claim',
  );
  assert.equal(
    isBlockedByOrderingPredecessor({
      hasOlderIncompletePredecessor: true,
      predecessorTerminalFailure: true,
    }),
    'terminalize',
  );
});

test('selectNextQueueKind alternates inbox and outbox fairly', () => {
  assert.equal(selectNextQueueKind({ processedInbox: 0, processedOutbox: 0 }), 'inbox');
  assert.equal(selectNextQueueKind({ processedInbox: 1, processedOutbox: 0 }), 'outbox');
});

test('parseRetryAfterHeader accepts only bounded numeric seconds', () => {
  assert.equal(parseRetryAfterHeader('120'), 120_000);
  assert.equal(parseRetryAfterHeader('invalid'), undefined);
});

test('parseRetryAfterHeader accepts bounded HTTP-date values', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(parseRetryAfterHeader('Wed, 01 Jan 2026 00:02:00 GMT', now), 120_000);
});
