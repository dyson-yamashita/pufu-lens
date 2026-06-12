import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithRetry } from './http-retry.js';

test('fetchWithRetry retries retryable status responses and keeps the final response', async () => {
  let calls = 0;
  const response = await fetchWithRetry('https://example.test/resource', undefined, {
    baseDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', {
          headers: { 'retry-after': '0' },
          status: 429,
        });
      }
      return Response.json({ ok: true });
    },
    maxAttempts: 2,
  });

  assert.equal(calls, 2);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('fetchWithRetry does not retry non-retryable status responses', async () => {
  let calls = 0;
  const response = await fetchWithRetry('https://example.test/not-found', undefined, {
    baseDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response('not found', { status: 404 });
    },
    maxAttempts: 3,
  });

  assert.equal(calls, 1);
  assert.equal(response.status, 404);
});

test('fetchWithRetry does not retry AbortError failures', async () => {
  let calls = 0;
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';

  await assert.rejects(
    () =>
      fetchWithRetry('https://example.test/abort', undefined, {
        baseDelayMs: 0,
        fetchImpl: async () => {
          calls += 1;
          throw abortError;
        },
        maxAttempts: 3,
      }),
    (error) => {
      assert.equal(error, abortError);
      return true;
    },
  );

  assert.equal(calls, 1);
});

test('fetchWithRetry cancels retryable response bodies before retrying', async () => {
  let calls = 0;
  let canceled = false;
  const response = await fetchWithRetry('https://example.test/retry-body', undefined, {
    baseDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
            start(controller) {
              controller.enqueue(new TextEncoder().encode('temporary failure'));
            },
          }),
          { status: 503 },
        );
      }
      return Response.json({ ok: true });
    },
    maxAttempts: 2,
  });

  assert.equal(calls, 2);
  assert.equal(canceled, true);
  assert.equal(response.status, 200);
});
