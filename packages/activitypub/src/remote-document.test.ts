import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePublicUrl } from '@fedify/vocab-runtime';
import {
  createBoundedRemoteJsonFetcher,
  REMOTE_FETCH_MAX_REDIRECTS,
  REMOTE_FETCH_MAX_RESPONSE_BYTES,
  REMOTE_FETCH_TOTAL_TIMEOUT_MS,
} from './remote-document.ts';

const canonicalOrigin = 'https://lens.test';

function createFetcher(input: {
  fetch?: typeof fetch;
  isDomainBlocked?: (host: string) => boolean;
  validateUrl?: (url: string) => Promise<void>;
}) {
  return createBoundedRemoteJsonFetcher({
    canonicalOrigin,
    fetch: input.fetch ?? (async () => new Response('{}', { status: 200 })),
    isDomainBlocked: input.isDomainBlocked ?? (() => false),
    validateUrl: input.validateUrl,
  });
}

const defaultPolicyRejectCases = [
  ['http://remote.example/article/1', /HTTPS/i],
  ['https://user:pass@remote.example/article/1', /credentials/i],
  ['https://remote.example/article/1#frag', /fragment/i],
  [`${canonicalOrigin}/article/1`, /canonical origin/i],
  ['https://127.0.0.1/article/1', /private|loopback|blocked|invalid/i],
  ['https://10.0.0.1/article/1', /private|blocked|invalid/i],
  ['https://169.254.169.254/latest/meta-data', /private|link-local|blocked|invalid/i],
  ['https://100.64.0.1/article/1', /private|special|blocked|invalid/i],
  ['https://[::1]/article/1', /private|loopback|blocked|invalid/i],
  ['https://[::ffff:127.0.0.1]/article/1', /private|loopback|blocked|invalid/i],
  ['https://[64:ff9b::192.0.2.1]/article/1', /private|blocked|invalid/i],
  ['https://[2001:0:4136:e378::]/article/1', /private|blocked|invalid/i],
  ['https://[2002:c000:0204::]/article/1', /private|blocked|invalid/i],
] as const;

const defaultPolicyErrorPattern =
  /private|loopback|blocked|invalid|DNS|UrlError|HTTPS|credentials|fragment|canonical/i;

for (const [url] of defaultPolicyRejectCases) {
  test(`bounded remote json fetcher rejects unsafe URL ${url}`, async () => {
    const fetcher = createFetcher({
      validateUrl: validatePublicUrl,
    });
    await assert.rejects(() => fetcher.fetchJsonDocument(url), defaultPolicyErrorPattern);
  });
}

test('bounded remote json fetcher rejects blocked exact and subdomain hosts', async () => {
  const fetcher = createFetcher({
    isDomainBlocked: (host) => host === 'blocked.example' || host.endsWith('.blocked.example'),
    validateUrl: async () => {},
  });
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://evil.blocked.example/article/1'),
    /blocked/i,
  );
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://blocked.example/article/1'),
    /blocked/i,
  );
});

test('bounded remote json fetcher rejects redirect targets that fail policy checks', async () => {
  const fetcher = createFetcher({
    fetch: async (url) => {
      const current = url.toString();
      if (current.startsWith('https://remote.example')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://127.0.0.1/private' },
        });
      }
      return new Response('{}', { status: 200 });
    },
    validateUrl: validatePublicUrl,
  });
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://remote.example/article/1'),
    defaultPolicyErrorPattern,
  );
});

test('bounded remote json fetcher revalidates each redirect hop and stops before second fetch on rebinding', async () => {
  let fetchCalls = 0;
  let validateCalls = 0;
  const fetcher = createFetcher({
    fetch: async (url) => {
      fetchCalls += 1;
      const current = url.toString();
      if (fetchCalls === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: `${current}?hop=1` },
        });
      }
      return new Response('{}', { status: 200 });
    },
    validateUrl: async () => {
      validateCalls += 1;
      if (validateCalls >= 2) {
        throw new Error('rebinding blocked');
      }
    },
  });
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://remote.example/article/1'),
    /rebinding blocked/i,
  );
  assert.equal(fetchCalls, 1);
});

test('bounded remote json fetcher rejects excessive redirects', async () => {
  let hops = 0;
  const fetcher = createFetcher({
    fetch: async (url) => {
      const current = url.toString();
      hops += 1;
      if (hops <= REMOTE_FETCH_MAX_REDIRECTS + 1) {
        return new Response(null, {
          status: 302,
          headers: { location: `${current}?hop=${hops}` },
        });
      }
      return new Response('{}', { status: 200 });
    },
    validateUrl: async () => {},
  });
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://remote.example/article/1'),
    /redirect/i,
  );
});

test('bounded remote json fetcher times out on slow fetch', async () => {
  const fetcher = createFetcher({
    fetch: async (_url, init) => {
      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }
        if (signal.aborted) {
          reject(new Error('Remote fetch timed out'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('Remote fetch timed out')), {
          once: true,
        });
      });
      return new Response('{}', { status: 200 });
    },
    validateUrl: async () => {},
  });
  const started = Date.now();
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://remote.example/article/1'),
    /timed out/i,
  );
  assert.ok(Date.now() - started >= REMOTE_FETCH_TOTAL_TIMEOUT_MS - 250);
});

test('bounded remote json fetcher rejects oversize Content-Length headers', async () => {
  const fetcher = createFetcher({
    fetch: async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(REMOTE_FETCH_MAX_RESPONSE_BYTES + 1) },
      }),
    validateUrl: async () => {},
  });
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://remote.example/article/1'),
    /size limit/i,
  );
});

test('bounded remote json fetcher rejects oversize streamed bodies and cancels reader', async () => {
  let cancelled = false;
  const fetcher = createFetcher({
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(REMOTE_FETCH_MAX_RESPONSE_BYTES));
            controller.enqueue(new Uint8Array(1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
    validateUrl: async () => {},
  });
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://remote.example/article/1'),
    /size limit/i,
  );
  assert.equal(cancelled, true);
});

test('bounded remote json fetcher rejects malformed JSON documents', async () => {
  const fetcher = createFetcher({
    fetch: async () => new Response('not-json', { status: 200 }),
    validateUrl: async () => {},
  });
  await assert.rejects(() => fetcher.fetchJsonDocument('https://remote.example/article/1'));
});

test('bounded remote json fetcher rejects non-object JSON documents', async () => {
  const fetcher = createFetcher({
    fetch: async () => new Response('[]', { status: 200 }),
    validateUrl: async () => {},
  });
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://remote.example/article/1'),
    /JSON object/i,
  );
});

test('bounded remote json fetcher rejects blocked subdomain hosts', async () => {
  const fetcher = createFetcher({
    isDomainBlocked: (host) => host === 'blocked.example' || host.endsWith('.blocked.example'),
    validateUrl: async () => {},
  });
  await assert.rejects(
    () => fetcher.fetchJsonDocument('https://evil.blocked.example/article/1'),
    /blocked/i,
  );
});
