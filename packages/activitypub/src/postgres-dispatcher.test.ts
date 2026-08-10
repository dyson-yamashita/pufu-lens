import assert from 'node:assert/strict';
import test from 'node:test';
import { DELIVERY_ERROR_CODES } from './delivery-errors.ts';
import { DISPATCHER_MAX_ATTEMPTS } from './dispatcher.ts';
import { classifyMaterializationFailure } from './postgres-dispatcher.ts';

test('classifyMaterializationFailure marks domain errors terminal and lease loss as no-op', () => {
  assert.deepEqual(
    classifyMaterializationFailure({
      attemptCount: 1,
      error: new Error(DELIVERY_ERROR_CODES.materializationPrivate),
    }),
    { kind: 'terminal_failed', code: DELIVERY_ERROR_CODES.materializationPrivate },
  );
  assert.deepEqual(
    classifyMaterializationFailure({
      attemptCount: 1,
      error: new Error(DELIVERY_ERROR_CODES.leaseLost),
    }),
    { kind: 'lease_lost' },
  );
});

test('classifyMaterializationFailure retries unknown errors until exhausted', () => {
  assert.deepEqual(
    classifyMaterializationFailure({
      attemptCount: 1,
      error: new Error('transient'),
    }),
    {
      kind: 'retry_pending',
      code: DELIVERY_ERROR_CODES.unknownDeliveryError,
      delayMs: 60_000,
    },
  );
  assert.deepEqual(
    classifyMaterializationFailure({
      attemptCount: DISPATCHER_MAX_ATTEMPTS,
      error: new Error('transient'),
    }),
    {
      kind: 'retry_exhausted',
      code: DELIVERY_ERROR_CODES.materializationRetryExhausted,
    },
  );
});
