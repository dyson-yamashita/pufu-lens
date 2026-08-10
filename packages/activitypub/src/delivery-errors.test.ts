import assert from 'node:assert/strict';
import test from 'node:test';
import { DELIVERY_ERROR_CODES, isDeliveryErrorCode, mapDeliveryError } from './delivery-errors.ts';

test('mapDeliveryError never leaks secret-bearing error messages', () => {
  const secret = 'super-secret-token-abc123';
  const mapped = mapDeliveryError(new Error(`delivery failed: ${secret}`));
  assert.equal(mapped.code, DELIVERY_ERROR_CODES.unknownDeliveryError);
  assert.equal(JSON.stringify(mapped).includes(secret), false);
});

test('mapDeliveryError maps HTTP statuses to fixed allowlist codes', () => {
  assert.equal(mapDeliveryError({ statusCode: 404 }).code, DELIVERY_ERROR_CODES.inboxGone);
  assert.equal(mapDeliveryError({ httpStatus: 404 }).code, DELIVERY_ERROR_CODES.inboxGone);
  assert.equal(mapDeliveryError({ httpStatus: 408 }).code, DELIVERY_ERROR_CODES.http408);
  assert.equal(mapDeliveryError({ httpStatus: 429 }).code, DELIVERY_ERROR_CODES.http429);
  assert.equal(mapDeliveryError({ httpStatus: 503 }).code, DELIVERY_ERROR_CODES.http5xx);
  assert.equal(mapDeliveryError({ httpStatus: 400 }).code, DELIVERY_ERROR_CODES.http4xx);
});

test('mapDeliveryError maps bounded Retry-After response headers', () => {
  const mapped = mapDeliveryError({
    statusCode: 429,
    responseHeaders: { 'retry-after': '90' },
  });
  assert.equal(mapped.retryAfterMs, 90_000);
});

test('isDeliveryErrorCode accepts only the fixed allowlist', () => {
  assert.equal(isDeliveryErrorCode(DELIVERY_ERROR_CODES.inboxGone), true);
  assert.equal(isDeliveryErrorCode('not_a_real_code'), false);
  assert.equal(isDeliveryErrorCode(null), false);
});

test('mapDeliveryError preserves known allowlist codes and rejects unknown codes', () => {
  assert.equal(
    mapDeliveryError({ code: DELIVERY_ERROR_CODES.materializationRetryExhausted }).code,
    DELIVERY_ERROR_CODES.materializationRetryExhausted,
  );
  assert.deepEqual(
    mapDeliveryError({
      code: DELIVERY_ERROR_CODES.http429,
      httpStatus: 429,
      retryAfterMs: 90_000,
    }),
    {
      code: DELIVERY_ERROR_CODES.http429,
      httpStatus: 429,
      retryAfterMs: 90_000,
    },
  );
  assert.equal(
    mapDeliveryError({ code: 'custom_internal_failure', message: 'secret detail' }).code,
    DELIVERY_ERROR_CODES.unknownDeliveryError,
  );
  assert.equal(
    JSON.stringify(mapDeliveryError({ code: 'custom_internal_failure', message: 'secret detail' })),
    JSON.stringify({ code: DELIVERY_ERROR_CODES.unknownDeliveryError }),
  );
});

test('mapDeliveryError ignores invalid HTTP status and retry numeric boundaries', () => {
  assert.deepEqual(mapDeliveryError({ httpStatus: Number.NaN }), {
    code: DELIVERY_ERROR_CODES.unknownDeliveryError,
  });
  assert.deepEqual(mapDeliveryError({ statusCode: Number.POSITIVE_INFINITY }), {
    code: DELIVERY_ERROR_CODES.unknownDeliveryError,
  });
  assert.deepEqual(mapDeliveryError({ status: 99 }), {
    code: DELIVERY_ERROR_CODES.unknownDeliveryError,
  });
  assert.deepEqual(mapDeliveryError({ httpStatus: 600 }), {
    code: DELIVERY_ERROR_CODES.unknownDeliveryError,
  });
  assert.deepEqual(mapDeliveryError({ httpStatus: 429.5 }), {
    code: DELIVERY_ERROR_CODES.unknownDeliveryError,
  });
  assert.deepEqual(
    mapDeliveryError({
      statusCode: Number.NaN,
      httpStatus: 429,
      responseHeaders: { 'retry-after': '30' },
    }),
    {
      code: DELIVERY_ERROR_CODES.http429,
      httpStatus: 429,
      retryAfterMs: 30_000,
    },
  );
});

test('mapDeliveryError rejects invalid retryAfterMs and falls back to Retry-After headers', () => {
  assert.deepEqual(
    mapDeliveryError({
      statusCode: 429,
      retryAfterMs: Number.NaN,
      responseHeaders: { 'retry-after': '45' },
    }),
    {
      code: DELIVERY_ERROR_CODES.http429,
      httpStatus: 429,
      retryAfterMs: 45_000,
    },
  );
  assert.deepEqual(
    mapDeliveryError({
      statusCode: 503,
      retryAfterMs: Number.POSITIVE_INFINITY,
      responseHeaders: { 'retry-after': '60' },
    }),
    {
      code: DELIVERY_ERROR_CODES.http5xx,
      httpStatus: 503,
      retryAfterMs: 60_000,
    },
  );
  assert.deepEqual(mapDeliveryError({ statusCode: 503, retryAfterMs: -1 }), {
    code: DELIVERY_ERROR_CODES.http5xx,
    httpStatus: 503,
  });
  assert.deepEqual(mapDeliveryError({ statusCode: 429, retryAfterMs: 12.5 }), {
    code: DELIVERY_ERROR_CODES.http429,
    httpStatus: 429,
    retryAfterMs: 12.5,
  });
});

test('mapDeliveryError does not propagate invalid numerics for known allowlist codes', () => {
  assert.deepEqual(
    mapDeliveryError({
      code: DELIVERY_ERROR_CODES.http5xx,
      httpStatus: Number.NaN,
      retryAfterMs: -1,
      message: 'secret detail',
    }),
    {
      code: DELIVERY_ERROR_CODES.http5xx,
    },
  );
});
