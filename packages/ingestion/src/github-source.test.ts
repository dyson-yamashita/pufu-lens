import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGitHubJson, fetchGitHubText, GitHubApiRequestError } from './github-source.js';

function mockFetchResponse(
  status: number,
  headers: Record<string, string> = {},
  body = '{}',
): typeof fetch {
  return (async () =>
    new Response(body, {
      headers,
      status,
    })) as typeof fetch;
}

test('fetchGitHubJson throws GitHubApiRequestError with finite x-ratelimit-remaining', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = mockFetchResponse(403, { 'x-ratelimit-remaining': '42' });

  await assert.rejects(
    () => fetchGitHubJson({ path: '/repos/example/repo/issues/1' }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiRequestError);
      assert.equal(error.status, 403);
      assert.equal(error.rateLimitRemaining, 42);
      return true;
    },
  );
});

test('fetchGitHubJson omits non-finite x-ratelimit-remaining values', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = mockFetchResponse(403, { 'x-ratelimit-remaining': 'not-a-number' });

  await assert.rejects(
    () => fetchGitHubJson({ path: '/repos/example/repo/issues/1' }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiRequestError);
      assert.equal(error.status, 403);
      assert.equal(error.rateLimitRemaining, undefined);
      return true;
    },
  );
});

test('fetchGitHubText throws GitHubApiRequestError with finite x-ratelimit-remaining', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = mockFetchResponse(403, { 'x-ratelimit-remaining': '7' }, 'diff');

  await assert.rejects(
    () => fetchGitHubText({ path: '/repos/example/repo/pulls/1' }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiRequestError);
      assert.equal(error.status, 403);
      assert.equal(error.rateLimitRemaining, 7);
      return true;
    },
  );
});

test('fetchGitHubText omits non-finite x-ratelimit-remaining values', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = mockFetchResponse(403, { 'x-ratelimit-remaining': '' }, 'diff');

  await assert.rejects(
    () => fetchGitHubText({ path: '/repos/example/repo/pulls/1' }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiRequestError);
      assert.equal(error.status, 403);
      assert.equal(error.rateLimitRemaining, undefined);
      return true;
    },
  );
});
