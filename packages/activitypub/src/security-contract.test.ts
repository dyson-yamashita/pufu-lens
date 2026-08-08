import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductionSafeDocumentLoader } from './security.ts';

const rejectedUrls = [
  'http://[::ffff:7f00:1]/',
  'http://127.0.0.1/',
  'http://10.0.0.1/',
  'http://192.168.1.1/',
  'http://169.254.169.254/',
  'http://[::1]/',
  'http://[fd12:3456:789a:1::1]/',
  'http://[64:ff9b:1::ffff:7f00:1]/',
  'http://[2001:0:28:4::]/',
  'http://[2002:c000:204::]/',
];

test('createProductionSafeDocumentLoader rejects loopback, private, and tunneling addresses', async () => {
  const loader = createProductionSafeDocumentLoader();

  for (const url of rejectedUrls) {
    await assert.rejects(
      () => loader.loadDocument(url),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /private|special|loopback|disallowed|unsafe/i);
        return true;
      },
      `expected rejection for ${url}`,
    );
  }
});

test('createProductionSafeDocumentLoader rejects private redirect targets before a second fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  const publicResourceUrl = 'https://93.184.216.34/resource';

  globalThis.fetch = (async (input: string | URL | Request) => {
    fetchCount += 1;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === publicResourceUrl) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: 'http://127.0.0.1/private',
        },
      });
    }

    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const loader = createProductionSafeDocumentLoader();
    await assert.rejects(
      () => loader.loadDocument(publicResourceUrl),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /redirect|private|disallowed|unsafe/i);
        return true;
      },
    );
    assert.equal(fetchCount, 1, 'private redirect must be rejected before a second fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
