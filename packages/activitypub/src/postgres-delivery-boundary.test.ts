import assert from 'node:assert/strict';
import test from 'node:test';
import { DELIVERY_ERROR_CODES, LeaseLostError } from './delivery-errors.ts';
import { isExpectedDeliveryFailure } from './postgres.ts';

test('isExpectedDeliveryFailure treats materialization retry exhaustion as a terminal delivery failure', () => {
  assert.equal(
    isExpectedDeliveryFailure({ code: DELIVERY_ERROR_CODES.materializationRetryExhausted }),
    true,
  );
});

test('isExpectedDeliveryFailure preserves lease loss rethrow and unknown error contracts', () => {
  assert.equal(isExpectedDeliveryFailure(new LeaseLostError()), false);
  assert.equal(isExpectedDeliveryFailure(new Error('unexpected processor failure')), false);
  assert.equal(isExpectedDeliveryFailure({ httpStatus: 503 }), true);
});
