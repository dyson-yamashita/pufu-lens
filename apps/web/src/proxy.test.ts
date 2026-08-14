import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateCryptoKeyPair,
  MemoryKvStore,
  signRequest,
  verifyRequestDetailed,
} from '@fedify/fedify';
import { exportSpki } from '@fedify/vocab-runtime';
import {
  buildActivityPubUriContract,
  createActivityPubFollowUseCases,
  createInMemoryActivityPubFollowRepository,
  createInMemoryActivityPubRepository,
  createProductionActivityPubFederation,
} from '@pufu-lens/activitypub';
import {
  createCachedActivityPubProxyHandlerResolver,
  rebuildActivityPubCanonicalRequest,
  resolveActivityPubProxyHandler,
  wrapActivityPubHandlerWithCanonicalRequest,
} from './activitypub-proxy.ts';

const canonicalOrigin = 'https://lens.hosted.app';
const canonicalHost = 'lens.hosted.app';
const spoofedForwardedHost = 'evil.example';
const internalOrigin = 'https://0.0.0.0:8080';
const internalHost = '0.0.0.0:8080';
const runAppOrigin = 'https://pufu-lens-web-abc123.run.app';
const runAppHost = 'pufu-lens-web-abc123.run.app';
const encryptionKey = Buffer.alloc(32, 4);

function isActivityPubCollectionResponse(value: unknown): value is { id: string; first: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('id' in value) || !('first' in value)) {
    return false;
  }
  return typeof value.id === 'string' && typeof value.first === 'string';
}

function assertActivityPubCollectionResponse(value: unknown): { id: string; first: string } {
  assert.ok(
    isActivityPubCollectionResponse(value),
    'expected ActivityPub collection response with string id and first',
  );
  return value;
}

function createQueue() {
  return {
    nativeRetrial: true as const,
    async enqueue() {
      return undefined;
    },
    async listen() {
      await new Promise<void>(() => undefined);
    },
  };
}

function createRemoteActorDocumentLoader(input: {
  actorUri: string;
  keyId: string;
  publicKeyPem: string;
}) {
  return async (url: URL | string) => {
    const href = url.toString();
    if (href === input.keyId) {
      return {
        contextUrl: null,
        documentUrl: href,
        document: {
          '@context': 'https://w3id.org/security/v1',
          id: input.keyId,
          type: 'CryptographicKey',
          owner: input.actorUri,
          publicKeyPem: input.publicKeyPem,
        },
      };
    }
    if (href === input.actorUri) {
      return {
        contextUrl: null,
        documentUrl: href,
        document: {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: input.actorUri,
          type: 'Person',
          preferredUsername: 'remote',
          inbox: 'https://remote.example/inbox',
          publicKey: {
            id: input.keyId,
            owner: input.actorUri,
            publicKeyPem: input.publicKeyPem,
          },
        },
      };
    }
    throw new Error(`unexpected document url: ${href}`);
  };
}

test('rebuildActivityPubCanonicalRequest rewrites internal Cloud Run requests to canonical origin', async () => {
  const body = JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'Follow',
    id: 'https://remote.example/activities/follow-1',
    actor: 'https://remote.example/users/remote',
    object: `${canonicalOrigin}/activitypub/actors/pufu`,
  });
  const internalUrl = `${runAppOrigin}/activitypub/inbox?delivery=1`;
  const request = new Request(internalUrl, {
    method: 'POST',
    headers: {
      host: runAppHost,
      'x-forwarded-host': spoofedForwardedHost,
      'content-type': 'application/activity+json',
      date: 'Fri, 14 Aug 2026 05:45:00 GMT',
      digest: 'SHA-256=placeholder',
      signature:
        'keyId="https://remote.example/users/remote#main-key",headers="(request-target) host date digest",signature="placeholder"',
    },
    body,
  });

  const rebuilt = rebuildActivityPubCanonicalRequest(request, canonicalOrigin);

  assert.equal(rebuilt.url, `${canonicalOrigin}/activitypub/inbox?delivery=1`);
  assert.equal(new URL(rebuilt.url).host, canonicalHost);
  assert.equal(rebuilt.method, 'POST');
  assert.equal(await rebuilt.text(), body);
  assert.equal(rebuilt.headers.get('host'), canonicalHost);
  assert.equal(rebuilt.headers.get('digest'), 'SHA-256=placeholder');
  assert.equal(rebuilt.headers.get('signature')?.includes('remote.example'), true);
  assert.equal(rebuilt.headers.get('x-forwarded-host'), spoofedForwardedHost);
});

test('rebuildActivityPubCanonicalRequest cannot escape canonical host via network-path pathname', async () => {
  const networkPath = '//evil.example/activitypub/inbox';
  const request = new Request(`${internalOrigin}${networkPath}?cursor=start`, {
    method: 'GET',
    headers: {
      host: internalHost,
      'x-forwarded-host': spoofedForwardedHost,
    },
  });

  const rebuilt = rebuildActivityPubCanonicalRequest(request, canonicalOrigin);

  assert.equal(new URL(rebuilt.url).host, canonicalHost);
  assert.equal(new URL(rebuilt.url).pathname, networkPath);
  assert.equal(new URL(rebuilt.url).search, '?cursor=start');
  assert.equal(rebuilt.headers.get('host'), canonicalHost);
  assert.equal(rebuilt.headers.get('x-forwarded-host'), spoofedForwardedHost);
});

test('canonical request wrapper restores HTTP signature verification for internal inbox requests', async () => {
  const inboxUrl = `${canonicalOrigin}/activitypub/actors/pufu/inbox`;
  const remoteActorUri = 'https://remote.example/users/remote';
  const remoteKeyId = `${remoteActorUri}#main-key`;
  const { privateKey, publicKey } = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5');
  const publicKeyPem = await exportSpki(publicKey);
  const documentLoader = createRemoteActorDocumentLoader({
    actorUri: remoteActorUri,
    keyId: remoteKeyId,
    publicKeyPem,
  });
  const body = JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'Follow',
    id: 'https://remote.example/activities/follow-1',
    actor: remoteActorUri,
    object: `${canonicalOrigin}/activitypub/actors/pufu`,
  });
  const signed = await signRequest(
    new Request(inboxUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/activity+json',
        host: canonicalHost,
        date: new Date().toUTCString(),
      },
      body,
    }),
    privateKey,
    new URL(remoteKeyId),
    { spec: 'draft-cavage-http-signatures-12' },
  );
  const internalRequest = new Request(`${internalOrigin}/activitypub/actors/pufu/inbox`, {
    method: 'POST',
    headers: signed.headers,
    body,
  });
  internalRequest.headers.set('host', internalHost);
  internalRequest.headers.set('x-forwarded-host', spoofedForwardedHost);

  const internalVerification = await verifyRequestDetailed(internalRequest, {
    documentLoader,
    timeWindow: false,
  });
  assert.equal(internalVerification.verified, false);

  const canonicalRequest = rebuildActivityPubCanonicalRequest(internalRequest, canonicalOrigin);
  const canonicalVerification = await verifyRequestDetailed(canonicalRequest, {
    documentLoader,
    timeWindow: false,
  });
  assert.equal(canonicalVerification.verified, true);
});

test('canonical request wrapper emits canonical collection links for internal follower requests', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  const followRepository = createInMemoryActivityPubFollowRepository();
  const followUseCases = createActivityPubFollowUseCases({
    canonicalOrigin,
    repository: followRepository,
    actorRepository: repository,
  });
  const federation = await createProductionActivityPubFederation({
    canonicalOrigin,
    repository,
    followUseCases,
    kv: new MemoryKvStore(),
    queue: createQueue(),
  });
  const uri = buildActivityPubUriContract(canonicalOrigin);
  const headers = { Accept: 'application/activity+json' };
  const internalRequest = new Request(`${internalOrigin}/activitypub/actors/all/followers`, {
    headers: {
      ...headers,
      host: internalHost,
      'x-forwarded-host': spoofedForwardedHost,
    },
  });

  const directResponse = await federation.fetch(internalRequest, { contextData: undefined });
  assert.equal(directResponse.status, 200);
  const directJson: unknown = await directResponse.json();
  const directCollection = assertActivityPubCollectionResponse(directJson);
  assert.equal(directCollection.id, uri.actorFollowersUrl('all'));
  assert.match(directCollection.first, new RegExp(`^${internalOrigin}`));

  let observedRequestUrl = '';
  const wrappedHandler = wrapActivityPubHandlerWithCanonicalRequest(canonicalOrigin, (request) => {
    observedRequestUrl = request.url;
    return federation.fetch(request, { contextData: undefined });
  });
  const wrappedResponse = await wrappedHandler(internalRequest);
  assert.equal(observedRequestUrl, uri.actorFollowersUrl('all'));
  assert.equal(wrappedResponse.status, 200);
  const wrappedJson: unknown = await wrappedResponse.json();
  const wrappedCollection = assertActivityPubCollectionResponse(wrappedJson);
  assert.equal(wrappedCollection.id, uri.actorFollowersUrl('all'));
  assert.match(wrappedCollection.first, new RegExp(`^${canonicalOrigin}`));
  assert.equal(wrappedCollection.first.includes(internalOrigin), false);
});

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
