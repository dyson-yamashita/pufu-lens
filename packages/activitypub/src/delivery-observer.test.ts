import assert from 'node:assert/strict';
import test from 'node:test';
import { DELIVERY_ERROR_CODES } from './delivery-errors.ts';
import {
  createDeliveryErrorObserver,
  mapFedifyDeliveryError,
  toObservedDeliveryError,
} from './delivery-observer.ts';

test('mapFedifyDeliveryError maps SendActivityError statusCode and Retry-After headers', () => {
  const mapped = mapFedifyDeliveryError({
    name: 'SendActivityError',
    statusCode: 429,
    responseHeaders: { 'retry-after': '120' },
    inbox: 'https://remote.example/inbox',
    body: 'secret response body must not leak',
  });
  assert.equal(mapped.code, DELIVERY_ERROR_CODES.http429);
  assert.equal(mapped.httpStatus, 429);
  assert.equal(mapped.retryAfterMs, 120_000);
  assert.equal(JSON.stringify(mapped).includes('secret'), false);
});

test('mapFedifyDeliveryError reads Retry-After from Fetch Headers instances', () => {
  const mapped429 = mapFedifyDeliveryError({
    name: 'SendActivityError',
    statusCode: 429,
    responseHeaders: new Headers({ 'retry-after': '120' }),
  });
  assert.equal(mapped429.code, DELIVERY_ERROR_CODES.http429);
  assert.equal(mapped429.retryAfterMs, 120_000);

  const mapped503 = mapFedifyDeliveryError({
    name: 'SendActivityError',
    statusCode: 503,
    responseHeaders: new Headers({ 'retry-after': '30' }),
  });
  assert.equal(mapped503.code, DELIVERY_ERROR_CODES.http5xx);
  assert.equal(mapped503.retryAfterMs, 30_000);
});

test('createDeliveryErrorObserver records one failure and consumes it once', () => {
  const observer = createDeliveryErrorObserver();
  observer.record({ statusCode: 410, responseHeaders: {} });
  const consumed = observer.consume();
  assert.equal(consumed?.code, DELIVERY_ERROR_CODES.inboxGone);
  assert.equal(observer.consume(), null);
});

test('toObservedDeliveryError preserves mapped fields for queue finalizers', () => {
  const error = toObservedDeliveryError({
    code: DELIVERY_ERROR_CODES.http5xx,
    httpStatus: 503,
    retryAfterMs: 30_000,
  });
  assert.equal((error as { code: string }).code, DELIVERY_ERROR_CODES.http5xx);
  assert.equal((error as { httpStatus: number }).httpStatus, 503);
});
