import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITYPUB_OPERATIONS_SCHEMA_VERSION,
  ACTIVITYPUB_ORIGIN_FAILURE_OTHER_LABEL,
  ACTIVITYPUB_ORIGIN_FAILURE_TOP_N,
  ACTIVITYPUB_QUEUE_METRICS_EVENT,
  type ActivityPubOriginFailureSummary,
  capActivityPubOriginFailureSummaries,
  isValidActivityPubQueueAdminChangeRef,
  parseCanonicalActivityPubQueueAdminTimestamp,
  serializeActivityPubOriginFailureMetricsEvent,
  serializeActivityPubQueueMetricsEvent,
} from './operations.ts';

function buildSummary(
  origin: string,
  counts: Partial<
    Pick<
      ActivityPubOriginFailureSummary,
      | 'retryCount'
      | 'retryExhaustedCount'
      | 'permanentFailureCount'
      | 'http429Count'
      | 'http5xxCount'
    >
  > = {},
): ActivityPubOriginFailureSummary {
  return {
    origin,
    retryCount: counts.retryCount ?? 0,
    retryExhaustedCount: counts.retryExhaustedCount ?? 0,
    permanentFailureCount: counts.permanentFailureCount ?? 0,
    http429Count: counts.http429Count ?? 0,
    http5xxCount: counts.http5xxCount ?? 0,
  };
}

test('serializeActivityPubQueueMetricsEvent emits bodyless queue metrics fields only', () => {
  const payload = serializeActivityPubQueueMetricsEvent({
    dispatcherDurationMs: 42,
    snapshot: {
      schemaVersion: ACTIVITYPUB_OPERATIONS_SCHEMA_VERSION,
      windowHours: 24,
      queueDepth: { pending: 1, running: 2, retryWait: 3 },
      oldestBacklogAgeSeconds: 90,
      succeededInWindow: 4,
      retryWaitCurrentCount: 3,
      retryExhaustedCurrentCount: 5,
      retryExhaustedInWindow: 6,
      permanentFailuresInWindow: 7,
      http429FailuresInWindow: 8,
      http5xxFailuresInWindow: 9,
      totalBusinessTableBytes: 10,
      originFailureSummaries: [],
    },
  });

  assert.equal(payload.event, ACTIVITYPUB_QUEUE_METRICS_EVENT);
  assert.equal(payload.bodyless, true);
  assert.equal(payload.queueDepthPending, 1);
  assert.equal(payload.queueDepthTotal, 6);
  assert.equal(payload.dispatcherDurationMs, 42);
  assert.equal(Object.hasOwn(payload, 'message_json'), false);
  assert.equal(Object.hasOwn(payload, 'payload_json'), false);
});

test('serializeActivityPubOriginFailureMetricsEvent emits totalFailureCount', () => {
  const payload = serializeActivityPubOriginFailureMetricsEvent({
    origin: 'https://remote.example',
    retryCount: 1,
    retryExhaustedCount: 2,
    permanentFailureCount: 3,
    http429Count: 4,
    http5xxCount: 5,
  });

  assert.equal(payload.origin, 'https://remote.example');
  assert.equal(payload.totalFailureCount, 15);
  assert.equal(Object.hasOwn(payload, 'message'), false);
  assert.equal(Object.hasOwn(payload, 'signature'), false);
});

test('queue admin validation helpers enforce operational change refs and canonical UTC timestamps', () => {
  assert.equal(isValidActivityPubQueueAdminChangeRef('ticket-901'), true);
  assert.equal(isValidActivityPubQueueAdminChangeRef('ops-db-test-requeue'), false);
  assert.equal(
    parseCanonicalActivityPubQueueAdminTimestamp('2026-01-01T00:00:00.000Z')?.toISOString(),
    '2026-01-01T00:00:00.000Z',
  );
  assert.equal(parseCanonicalActivityPubQueueAdminTimestamp('2026-01-01T00:00:00Z'), undefined);
});

test('capActivityPubOriginFailureSummaries keeps top twenty origins and aggregates the rest', () => {
  const tailSummaries = [
    buildSummary('https://tail-a.example', {
      retryCount: 1,
      retryExhaustedCount: 1,
      permanentFailureCount: 1,
      http429Count: 1,
      http5xxCount: 1,
    }),
    buildSummary('https://tail-b.example', {
      retryCount: 2,
      retryExhaustedCount: 1,
      permanentFailureCount: 1,
      http429Count: 1,
      http5xxCount: 1,
    }),
    buildSummary('https://tail-c.example', {
      retryCount: 1,
      retryExhaustedCount: 2,
      permanentFailureCount: 1,
      http429Count: 1,
      http5xxCount: 1,
    }),
  ];
  const topSummaries = Array.from({ length: ACTIVITYPUB_ORIGIN_FAILURE_TOP_N }, (_, index) =>
    buildSummary(`https://origin-${index}.example`, {
      retryCount: ACTIVITYPUB_ORIGIN_FAILURE_TOP_N + 10 - index,
    }),
  );
  const summaries = [...topSummaries, ...tailSummaries];

  const capped = capActivityPubOriginFailureSummaries(summaries);
  assert.equal(capped.length, ACTIVITYPUB_ORIGIN_FAILURE_TOP_N + 1);
  assert.equal(capped.at(-1)?.origin, ACTIVITYPUB_ORIGIN_FAILURE_OTHER_LABEL);
  assert.equal(capped[0]?.origin, 'https://origin-0.example');

  const other = capped.at(-1);
  assert.ok(other);
  assert.equal(other.retryCount, 4);
  assert.equal(other.retryExhaustedCount, 4);
  assert.equal(other.permanentFailureCount, 3);
  assert.equal(other.http429Count, 3);
  assert.equal(other.http5xxCount, 3);
});
