import assert from 'node:assert/strict';
import test from 'node:test';
import { DELIVERY_ERROR_CODES } from './delivery-errors.ts';
import { DeliveryTimeoutError, withTimedDeliveryFetch } from './delivery-fetch.ts';

function createAbortOnSignalFetch(): {
  readonly fetch: typeof fetch;
  readonly getLastSignal: () => AbortSignal | undefined;
} {
  let lastSignal: AbortSignal | undefined;
  const fetchImpl = ((_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    lastSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('expected abort signal'));
        return;
      }
      if (signal.aborted) {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        },
        { once: true },
      );
    });
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    getLastSignal: () => lastSignal,
  };
}

test('withTimedDeliveryFetch restores global fetch after success', async () => {
  const originalFetch = globalThis.fetch;
  await withTimedDeliveryFetch({ timeoutMs: 1_000 }, async () => {
    await globalThis.fetch('https://example.test/inbox', { method: 'HEAD' }).catch(() => undefined);
  });
  assert.equal(globalThis.fetch, originalFetch);
});

test('DeliveryTimeoutError maps to delivery_timeout code', () => {
  const error = new DeliveryTimeoutError();
  assert.equal(error.message, DELIVERY_ERROR_CODES.deliveryTimeout);
});

test('withTimedDeliveryFetch maps timeout abort to DeliveryTimeoutError', async () => {
  const stub = createAbortOnSignalFetch();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  const timeoutController = new AbortController();

  try {
    await assert.rejects(
      () =>
        withTimedDeliveryFetch(
          {
            timeoutMs: 1_000,
            createTimeoutSignalForTest: () => timeoutController.signal,
          },
          async () => {
            const pending = globalThis.fetch('https://example.test/inbox');
            timeoutController.abort();
            await pending;
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof DeliveryTimeoutError);
        assert.equal(error.message, DELIVERY_ERROR_CODES.deliveryTimeout);
        return true;
      },
    );
    assert.equal(timeoutController.signal.aborted, true);
    assert.equal(stub.getLastSignal()?.aborted, true);
    assert.equal(globalThis.fetch, stub.fetch);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('withTimedDeliveryFetch does not classify caller abort as delivery timeout', async () => {
  const stub = createAbortOnSignalFetch();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  const callerController = new AbortController();
  callerController.abort();
  const timeoutController = new AbortController();

  try {
    await assert.rejects(
      () =>
        withTimedDeliveryFetch(
          {
            createTimeoutSignalForTest: () => timeoutController.signal,
          },
          () => globalThis.fetch('https://example.test/inbox', { signal: callerController.signal }),
        ),
      (error: unknown) => {
        assert.notEqual(error instanceof DeliveryTimeoutError, true);
        return true;
      },
    );
    assert.equal(timeoutController.signal.aborted, false);
    assert.equal(globalThis.fetch, stub.fetch);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
