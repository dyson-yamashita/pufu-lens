import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCachedActivityPubProxyHandlerResolver,
  resolveActivityPubProxyHandler,
} from './activitypub-proxy.ts';

test('resolveActivityPubProxyHandler returns 503 when production init fails', async () => {
  const errors: string[] = [];
  const originalError = console.error;
  Object.defineProperty(console, 'error', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    },
  });
  try {
    const handler = await resolveActivityPubProxyHandler({
      env: { ACTIVITYPUB_ENABLED: '1', ACTIVITYPUB_SPIKE_ENABLED: '1' },
      createProductionFederation: async () => {
        throw new Error('init failed with secret pem');
      },
      createSpikeFederation: async () => {
        throw new Error('spike should not run');
      },
    });

    const response = await handler(new Request('https://lens.test/.well-known/webfinger'));
    assert.equal(response.status, 503);
    assert.equal(errors.length, 1);
    assert.equal(errors[0], 'ActivityPub production runtime failed to initialize');
    assert.equal(errors.join('\n').includes('secret pem'), false);
  } finally {
    Object.defineProperty(console, 'error', {
      configurable: true,
      writable: true,
      value: originalError,
    });
  }
});

test('resolveActivityPubProxyHandler prefers production over spike', async () => {
  let spikeCalled = false;
  const handler = await resolveActivityPubProxyHandler({
    env: { ACTIVITYPUB_ENABLED: '1', ACTIVITYPUB_SPIKE_ENABLED: '1' },
    createProductionFederation: async () => ({
      fetch: async () => new Response('ok', { status: 200 }),
    }),
    createSpikeFederation: async () => {
      spikeCalled = true;
      throw new Error('spike should not run');
    },
  });

  const response = await handler(new Request('https://lens.test/activitypub/actors/all'));
  assert.equal(response.status, 200);
  assert.equal(spikeCalled, false);
});

test('cached proxy handler initializes production federation only once', async () => {
  let factoryCalls = 0;
  const resolver = createCachedActivityPubProxyHandlerResolver({
    env: { ACTIVITYPUB_ENABLED: '1' },
    createProductionFederation: async () => {
      factoryCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        fetch: async () => new Response('ok', { status: 200 }),
      };
    },
  });

  const [first, second] = await Promise.all([resolver.resolve(), resolver.resolve()]);
  const firstResponse = await first(new Request('https://lens.test/activitypub/actors/all'));
  const secondResponse = await second(new Request('https://lens.test/.well-known/webfinger'));

  assert.equal(factoryCalls, 1);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  resolver.reset();
});

test('cached proxy handler retries failed production initialization on next resolve', async () => {
  let factoryCalls = 0;
  const resolver = createCachedActivityPubProxyHandlerResolver({
    env: { ACTIVITYPUB_ENABLED: '1' },
    createProductionFederation: async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        throw new Error('init failed with secret pem');
      }
      return {
        fetch: async () => new Response('ok', { status: 200 }),
      };
    },
  });

  const [first, second] = await Promise.all([resolver.resolve(), resolver.resolve()]);
  const firstResponse = await first(new Request('https://lens.test/activitypub/actors/all'));
  const secondResponse = await second(new Request('https://lens.test/.well-known/webfinger'));

  assert.equal(factoryCalls, 1);
  assert.equal(firstResponse.status, 503);
  assert.equal(secondResponse.status, 503);

  const recovered = await resolver.resolve();
  const recoveredResponse = await recovered(
    new Request('https://lens.test/activitypub/actors/all'),
  );

  assert.equal(factoryCalls, 2);
  assert.equal(recoveredResponse.status, 200);
  resolver.reset();
});

test('cached proxy handler does not cache rejected resolver configuration', async () => {
  const input: {
    env: { ACTIVITYPUB_ENABLED: '1' };
    createProductionFederation?: () => Promise<{ fetch: () => Promise<Response> }>;
  } = {
    env: { ACTIVITYPUB_ENABLED: '1' },
  };
  const resolver = createCachedActivityPubProxyHandlerResolver(input);

  await assert.rejects(() => resolver.resolve(), /createProductionFederation is required/i);

  input.createProductionFederation = async () => ({
    fetch: async () => new Response('ok', { status: 200 }),
  });
  const handler = await resolver.resolve();
  const response = await handler(new Request('https://lens.test/activitypub/actors/all'));

  assert.equal(response.status, 200);
  resolver.reset();
});
