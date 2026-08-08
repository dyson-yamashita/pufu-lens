import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCachedActivityPubProxyHandlerResolver,
  resolveActivityPubProxyHandler,
} from './activitypub-proxy.ts';

test('resolveActivityPubProxyHandler returns 503 when production init fails', async () => {
  const handler = await resolveActivityPubProxyHandler({
    env: { ACTIVITYPUB_ENABLED: '1', ACTIVITYPUB_SPIKE_ENABLED: '1' },
    createProductionFederation: async () => {
      throw new Error('init failed with secret pem');
    },
    createSpikeFederation: async () => {
      throw new Error('spike should not run');
    },
  });

  const response = (await handler(
    new Request('https://lens.test/.well-known/webfinger'),
  )) as Response;
  assert.equal(response.status, 503);
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

  const response = (await handler(
    new Request('https://lens.test/activitypub/actors/all'),
  )) as Response;
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
  const firstResponse = (await first(
    new Request('https://lens.test/activitypub/actors/all'),
  )) as Response;
  const secondResponse = (await second(
    new Request('https://lens.test/.well-known/webfinger'),
  )) as Response;

  assert.equal(factoryCalls, 1);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  resolver.reset();
});
