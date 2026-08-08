import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRemoteActorResolver,
  parseBlockedDomainsFromEnv,
  type RemoteActorReadModel,
} from './remote-actor.ts';

const canonicalOrigin = 'https://lens.test';

function createFixtureActorDocument(input: {
  actorUri: string;
  inboxUri: string;
  sharedInboxUri?: string;
}): unknown {
  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        sharedInbox: 'https://www.w3.org/ns/activitystreams#sharedInbox',
      },
    ],
    id: input.actorUri,
    type: 'Service',
    inbox: input.inboxUri,
    endpoints: input.sharedInboxUri
      ? {
          sharedInbox: input.sharedInboxUri,
        }
      : undefined,
  };
}

test('remote actor resolver resolves acct handle via WebFinger then Actor document', async () => {
  const remoteOrigin = 'https://remote.example';
  const actorUri = `${remoteOrigin}/users/alice`;
  const inboxUri = `${actorUri}/inbox`;
  const sharedInboxUri = `${remoteOrigin}/inbox`;
  const responses = new Map<string, Response>();

  responses.set(
    `${remoteOrigin}/.well-known/webfinger?resource=${encodeURIComponent('acct:alice@remote.example')}`,
    new Response(
      JSON.stringify({
        subject: 'acct:alice@remote.example',
        links: [
          {
            rel: 'self',
            type: 'application/activity+json',
            href: actorUri,
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/jrd+json' } },
    ),
  );
  responses.set(
    actorUri,
    new Response(
      JSON.stringify(createFixtureActorDocument({ actorUri, inboxUri, sharedInboxUri })),
      {
        status: 200,
        headers: { 'content-type': 'application/activity+json' },
      },
    ),
  );

  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async (url) => {
      const key = typeof url === 'string' ? url : url.toString();
      const response = responses.get(key);
      if (!response) {
        return new Response('not found', { status: 404 });
      }
      return response.clone();
    },
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });

  const resolved = await resolver.resolve('acct:alice@remote.example');
  assert.deepEqual(resolved, {
    actorUri,
    inboxUri,
    sharedInboxUri,
  } satisfies RemoteActorReadModel);
});

test('remote actor resolver rejects blocked domains', async () => {
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async () => new Response('ok'),
    isDomainBlocked: (host: string) => host === 'blocked.example',
  });
  await assert.rejects(() => resolver.resolve('https://blocked.example/users/alice'), /blocked/i);
});

test('remote actor resolver rejects oversize responses', async () => {
  const remoteOrigin = 'https://remote.example';
  const actorUri = `${remoteOrigin}/users/alice`;
  const oversizedBody = 'x'.repeat(1024 * 1024 + 1);

  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async () =>
      new Response(oversizedBody, {
        status: 200,
        headers: { 'content-type': 'application/activity+json' },
      }),
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });

  await assert.rejects(() => resolver.resolve(actorUri), /size|limit/i);
});

test('remote actor resolver rejects malformed handle input', async () => {
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async () => new Response('ok'),
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });
  await assert.rejects(() => resolver.resolve('x'.repeat(600)), /length/i);
});

test('remote actor resolver rejects local canonical origin subscriptions', async () => {
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async () => new Response('ok'),
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });
  await assert.rejects(
    () => resolver.resolve(`${canonicalOrigin}/activitypub/actors/all`),
    /local canonical origin/i,
  );
});

test('remote actor resolver rejects WebFinger subject mismatch', async () => {
  const remoteOrigin = 'https://remote.example';
  const actorUri = `${remoteOrigin}/users/alice`;
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async (url) => {
      const key = typeof url === 'string' ? url : url.toString();
      if (key.includes('/.well-known/webfinger')) {
        return new Response(
          JSON.stringify({
            subject: 'acct:bob@remote.example',
            links: [{ rel: 'self', type: 'application/activity+json', href: actorUri }],
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    },
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });
  await assert.rejects(() => resolver.resolve('acct:alice@remote.example'), /subject mismatch/i);
});

test('remote actor resolver rejects HTTP redirect targets', async () => {
  const remoteOrigin = 'https://remote.example';
  const actorUri = `${remoteOrigin}/users/alice`;
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async (url) => {
      const key = typeof url === 'string' ? url : url.toString();
      if (key === actorUri) {
        return new Response('', {
          status: 302,
          headers: { location: 'http://private.remote.example/users/alice' },
        });
      }
      return new Response('not found', { status: 404 });
    },
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });
  await assert.rejects(() => resolver.resolve(actorUri), /HTTPS/i);
});

test('remote actor resolver rejects actor document id mismatch after redirects', async () => {
  const remoteOrigin = 'https://remote.example';
  const actorUri = `${remoteOrigin}/users/alice`;
  const redirectedUri = `${remoteOrigin}/users/alice-canonical`;
  const inboxUri = `${redirectedUri}/inbox`;
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async (url) => {
      const key = typeof url === 'string' ? url : url.toString();
      if (key === actorUri) {
        return new Response('', { status: 302, headers: { location: redirectedUri } });
      }
      if (key === redirectedUri) {
        return new Response(JSON.stringify(createFixtureActorDocument({ actorUri, inboxUri })), {
          status: 200,
          headers: { 'content-type': 'application/activity+json' },
        });
      }
      return new Response('not found', { status: 404 });
    },
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });
  await assert.rejects(() => resolver.resolve(actorUri), /does not match resolved URL/i);
});

test('parseBlockedDomainsFromEnv blocks exact hostnames and subdomains', () => {
  const isBlocked = parseBlockedDomainsFromEnv('blocked.example');
  assert.equal(isBlocked('blocked.example'), true);
  assert.equal(isBlocked('evil.blocked.example'), true);
  assert.equal(isBlocked('notblocked.example'), false);
});

test('remote actor resolver rejects blocked subdomain hosts', async () => {
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async () => new Response('ok'),
    isDomainBlocked: (host) => host === 'blocked.example' || host.endsWith('.blocked.example'),
    validateUrl: async () => {},
  });
  await assert.rejects(
    () => resolver.resolve('https://tenant.blocked.example/users/alice'),
    /blocked/i,
  );
});

test('remote actor resolver rejects HTTP inbox URLs', async () => {
  const remoteOrigin = 'https://remote.example';
  const actorUri = `${remoteOrigin}/users/alice`;
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async (url) => {
      const key = typeof url === 'string' ? url : url.toString();
      if (key === actorUri) {
        return new Response(
          JSON.stringify({
            id: actorUri,
            type: 'Service',
            inbox: 'http://private.remote.example/inbox',
          }),
          { status: 200, headers: { 'content-type': 'application/activity+json' } },
        );
      }
      return new Response('not found', { status: 404 });
    },
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });
  await assert.rejects(() => resolver.resolve(actorUri), /HTTPS/i);
});

test('remote actor resolver aborts slow DNS validation within deadline', async () => {
  const remoteOrigin = 'https://remote.example';
  const actorUri = `${remoteOrigin}/users/alice`;
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async (url) => {
      const key = typeof url === 'string' ? url : url.toString();
      if (key === actorUri) {
        return new Response(
          JSON.stringify(createFixtureActorDocument({ actorUri, inboxUri: `${actorUri}/inbox` })),
          { status: 200, headers: { 'content-type': 'application/activity+json' } },
        );
      }
      return new Response('not found', { status: 404 });
    },
    isDomainBlocked: () => false,
    validateUrl: () => new Promise<void>(() => undefined),
  });
  await assert.rejects(() => resolver.resolve(actorUri), /timed out/i);
});

test('remote actor resolver rejects redirect targets on blocked exact domains before fetch', async () => {
  const blockedOrigin = 'https://blocked.example';
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async () => new Response('ok'),
    isDomainBlocked: (host) => host === 'blocked.example',
    validateUrl: async () => {},
  });
  await assert.rejects(() => resolver.resolve(`${blockedOrigin}/users/alice`), /blocked/i);
});

test('remote actor resolver validates inbox and sharedInbox URLs and rejects blocked hosts', async () => {
  const remoteOrigin = 'https://remote.example';
  const actorUri = `${remoteOrigin}/users/alice`;
  const inboxUri = `${actorUri}/inbox`;
  const sharedInboxUri = 'https://tenant.blocked.example/shared-inbox';
  let validateCalls = 0;
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async (url) => {
      const key = typeof url === 'string' ? url : url.toString();
      if (key === actorUri) {
        return new Response(
          JSON.stringify({
            id: actorUri,
            type: 'Service',
            inbox: inboxUri,
            endpoints: { sharedInbox: sharedInboxUri },
          }),
          { status: 200, headers: { 'content-type': 'application/activity+json' } },
        );
      }
      return new Response('not found', { status: 404 });
    },
    isDomainBlocked: (host) => host === 'blocked.example' || host.endsWith('.blocked.example'),
    validateUrl: async (url) => {
      validateCalls += 1;
      if (url.includes('blocked.example')) {
        throw new Error('private address blocked');
      }
    },
  });
  await assert.rejects(() => resolver.resolve(actorUri), /blocked|private/i);
  assert.ok(validateCalls >= 2);
});
