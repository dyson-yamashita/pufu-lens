import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryKvStore } from '@fedify/fedify';
import {
  createProductionActivityPubFederation,
  createTestActivityPubFederation,
} from './federation.ts';
import { createActivityPubFollowUseCases } from './follow-use-cases.ts';
import { createInMemoryActivityPubRepository } from './in-memory-actor-repository.ts';
import { createInMemoryActivityPubFollowRepository } from './in-memory-follow-repository.ts';
import { ActivityPubTestRuntimeDisabledError } from './test-runtime-guard.ts';
import { buildActivityPubUriContract } from './uri-contract.ts';

const canonicalOrigin = 'https://lens.test';
const canonicalHost = 'lens.test';
const encryptionKey = Buffer.alloc(32, 9);
const projectId = '20000000-0000-0000-0000-000000000001';
const projectSlug = 'sample-project';
const reportId = '30000000-0000-0000-0000-000000000001';

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

async function assertRemotelyVisibleActorContract(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  uri: ReturnType<typeof buildActivityPubUriContract>,
  preferredUsername: string,
) {
  const headers = { Accept: 'application/activity+json' };
  const webfingerResponse = await fetch(
    `${canonicalOrigin}/.well-known/webfinger?resource=${uri.webfingerAcct(preferredUsername)}`,
  );
  assert.equal(webfingerResponse.status, 200);
  const webfinger = (await webfingerResponse.json()) as {
    subject: string;
    links: Array<{ rel: string; href?: string }>;
  };
  assert.equal(webfinger.subject, uri.webfingerAcct(preferredUsername));
  const selfLink = webfinger.links.find((link) => link.rel === 'self');
  assert.equal(selfLink?.href, uri.actorUrl(preferredUsername));

  const actorResponse = await fetch(uri.actorUrl(preferredUsername), { headers });
  assert.equal(actorResponse.status, 200);
  const actor = (await actorResponse.json()) as Record<string, string>;
  assert.equal(actor.id, uri.actorUrl(preferredUsername));
  assert.equal(actor.preferredUsername, preferredUsername);
  assert.equal(actor.inbox, uri.personalInboxUrl(preferredUsername));
  assert.equal(actor.outbox, uri.actorOutboxUrl(preferredUsername));
  assert.equal(actor.followers, uri.actorFollowersUrl(preferredUsername));
  assert.equal(actor.following, uri.actorFollowingUrl(preferredUsername));

  const keyResponse = await fetch(uri.actorKeyId(preferredUsername), { headers });
  assert.equal(keyResponse.status, 200);
  const key = (await keyResponse.json()) as { id: string };
  assert.ok(
    key.id === uri.actorKeyId(preferredUsername) || key.id === uri.actorUrl(preferredUsername),
    `unexpected public key id: ${key.id}`,
  );
}

test('production federation resolves aggregate and project actors with endpoint contracts', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample Project',
    visibility: 'public',
  });
  await repository.seedProjectActor({
    projectId,
    projectSlug,
    projectName: 'Sample Project',
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: true,
  });

  const federation = await createProductionActivityPubFederation({
    canonicalOrigin,
    repository,
    kv: new MemoryKvStore(),
    queue: createQueue(),
  });

  const fetch = (input: string, init?: RequestInit) =>
    federation.fetch(new Request(input, init), { contextData: undefined });
  const uri = buildActivityPubUriContract(canonicalOrigin);

  await assertRemotelyVisibleActorContract(fetch, uri, 'all');
  await assertRemotelyVisibleActorContract(fetch, uri, projectSlug);

  const headers = { Accept: 'application/activity+json' };
  for (const collectionUrl of [
    uri.actorFollowersUrl(projectSlug),
    uri.actorFollowingUrl(projectSlug),
    uri.actorOutboxUrl(projectSlug),
  ]) {
    assert.equal((await fetch(collectionUrl, { headers })).status, 200);
  }
});

test('production federation returns 404 for disabled, private, and missing actors across all endpoints', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample Project',
    visibility: 'public',
  });
  await repository.seedProjectActor({
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: false,
  });
  const privateProjectId = '20000000-0000-0000-0000-000000000002';
  repository.seedProject({
    id: privateProjectId,
    slug: 'private-project',
    name: 'Private Project',
    visibility: 'private',
  });
  await repository.seedProjectActor({
    projectId: privateProjectId,
    projectSlug: 'private-project',
    preferredUsername: 'private-project',
    visibility: 'private',
    enabled: true,
  });
  repository.seedPublicReport({
    reportId,
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    title: 'Quarterly Update',
    summary: 'Summary',
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
  });

  const federation = await createProductionActivityPubFederation({
    canonicalOrigin,
    repository,
    kv: new MemoryKvStore(),
    queue: createQueue(),
  });
  const fetch = (input: string, init?: RequestInit) =>
    federation.fetch(new Request(input, init), { contextData: undefined });
  const uri = buildActivityPubUriContract(canonicalOrigin);
  const headers = { Accept: 'application/activity+json' };

  for (const username of [projectSlug, 'private-project', 'missing-project']) {
    const statuses = await Promise.all([
      fetch(
        `${canonicalOrigin}/.well-known/webfinger?resource=acct:${username}@${canonicalHost}`,
      ).then((r) => r.status),
      fetch(uri.actorUrl(username), { headers }).then((r) => r.status),
      fetch(uri.actorFollowersUrl(username), { headers }).then((r) => r.status),
      fetch(uri.actorFollowingUrl(username), { headers }).then((r) => r.status),
      fetch(uri.actorOutboxUrl(username), { headers }).then((r) => r.status),
    ]);
    assert.deepEqual(
      statuses,
      [404, 404, 404, 404, 404],
      `expected hidden actor ${username} to 404 everywhere`,
    );
  }

  assert.equal((await fetch(uri.reportArticleUrl(reportId), { headers })).status, 404);
});

test('production federation does not emit Article when singleton config is note', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample Project',
    visibility: 'public',
  });
  await repository.seedProjectActor({
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: true,
  });
  repository.setInstanceObjectRepresentation('note');
  repository.seedPublicReport({
    reportId,
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    title: 'Quarterly Update',
    summary: 'Summary',
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
  });

  const federation = await createProductionActivityPubFederation({
    canonicalOrigin,
    repository,
    kv: new MemoryKvStore(),
    queue: createQueue(),
  });
  const uri = buildActivityPubUriContract(canonicalOrigin);
  const response = await federation.fetch(
    new Request(uri.reportArticleUrl(reportId), {
      headers: { Accept: 'application/activity+json' },
    }),
    { contextData: undefined },
  );
  assert.equal(response.status, 404);
});

test('production federation resolves public report articles when config is article', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample Project',
    visibility: 'public',
  });
  await repository.seedProjectActor({
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: true,
  });
  repository.seedPublicReport({
    reportId,
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    title: 'Quarterly Update',
    summary: 'A concise public summary.',
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
  });

  const federation = await createProductionActivityPubFederation({
    canonicalOrigin,
    repository,
    kv: new MemoryKvStore(),
    queue: createQueue(),
  });
  const uri = buildActivityPubUriContract(canonicalOrigin);
  const response = await federation.fetch(
    new Request(uri.reportArticleUrl(reportId), {
      headers: { Accept: 'application/activity+json' },
    }),
    { contextData: undefined },
  );
  assert.equal(response.status, 200);
});

test('production federation followers and following expose accepted actor URIs only', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample Project',
    visibility: 'public',
  });
  const actor = await repository.seedProjectActor({
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: true,
  });
  const followRepository = createInMemoryActivityPubFollowRepository();
  followRepository.seedFollow({
    id: 'f0000000-0000-0000-0000-000000000101',
    direction: 'inbound',
    localActorId: actor.id,
    remoteActorUri: 'https://remote.example/users/follower-1',
    remoteInboxUri: 'https://remote.example/inbox',
    remoteSharedInboxUri: null,
    followActivityUri: 'https://remote.example/activities/follow-1',
    status: 'accepted',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    acceptedAt: new Date('2026-08-01T00:00:00.000Z'),
    undoneAt: null,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  followRepository.seedFollow({
    id: 'f0000000-0000-0000-0000-000000000102',
    direction: 'outbound',
    localActorId: actor.id,
    remoteActorUri: 'https://remote.example/users/followed-1',
    remoteInboxUri: 'https://remote.example/users/followed-1/inbox',
    remoteSharedInboxUri: null,
    followActivityUri: `${canonicalOrigin}/activitypub/activities/follow/out-1`,
    status: 'accepted',
    createdAt: new Date('2026-08-02T00:00:00.000Z'),
    acceptedAt: new Date('2026-08-02T00:00:00.000Z'),
    undoneAt: null,
    updatedAt: new Date('2026-08-02T00:00:00.000Z'),
  });
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
  const followersResponse = await federation.fetch(
    new Request(uri.actorFollowersUrl(projectSlug), { headers }),
    { contextData: undefined },
  );
  assert.equal(followersResponse.status, 200);
  const followersCollection = (await followersResponse.json()) as {
    type: string;
    orderedItems?: string[];
    totalItems?: number;
    first?: string;
  };
  assert.equal(followersCollection.totalItems, 1);
  assert.ok(followersCollection.first);
  const followersPageResponse = await federation.fetch(
    new Request(followersCollection.first as string, { headers }),
    { contextData: undefined },
  );
  assert.equal(followersPageResponse.status, 200);
  const followers = (await followersPageResponse.json()) as { orderedItems?: string[] };
  assert.deepEqual(followers.orderedItems, ['https://remote.example/users/follower-1']);

  const followingResponse = await federation.fetch(
    new Request(uri.actorFollowingUrl(projectSlug), { headers }),
    { contextData: undefined },
  );
  assert.equal(followingResponse.status, 200);
  const followingCollection = (await followingResponse.json()) as {
    orderedItems?: string[];
    totalItems?: number;
    first?: string;
  };
  assert.equal(followingCollection.totalItems, 1);
  assert.ok(followingCollection.first);
  const followingPageResponse = await federation.fetch(
    new Request(followingCollection.first as string, { headers }),
    { contextData: undefined },
  );
  assert.equal(followingPageResponse.status, 200);
  const following = (await followingPageResponse.json()) as { orderedItems?: string[] };
  assert.deepEqual(following.orderedItems, ['https://remote.example/users/followed-1']);
});

test('production federation followers collection paginates with opaque cursor and counter', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  repository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample Project',
    visibility: 'public',
  });
  const actor = await repository.seedProjectActor({
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: true,
  });
  const followRepository = createInMemoryActivityPubFollowRepository();
  const now = new Date('2026-08-01T00:00:00.000Z');
  for (let index = 0; index < 25; index += 1) {
    followRepository.seedFollow({
      id: `f2000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      direction: 'inbound',
      localActorId: actor.id,
      remoteActorUri: `https://remote.example/users/page-${index}`,
      remoteInboxUri: 'https://remote.example/inbox',
      remoteSharedInboxUri: null,
      followActivityUri: `https://remote.example/activities/page-${index}`,
      status: 'accepted',
      createdAt: new Date(now.getTime() + index * 1000),
      acceptedAt: new Date(now.getTime() + index * 1000),
      undoneAt: null,
      updatedAt: new Date(now.getTime() + index * 1000),
    });
  }
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
  const collectionResponse = await federation.fetch(
    new Request(uri.actorFollowersUrl(projectSlug), { headers }),
    { contextData: undefined },
  );
  assert.equal(collectionResponse.status, 200);
  const collection = (await collectionResponse.json()) as {
    totalItems?: number;
    first?: string;
  };
  assert.equal(collection.totalItems, 25);
  assert.ok(collection.first);
  const firstPageResponse = await federation.fetch(
    new Request(collection.first as string, { headers }),
    {
      contextData: undefined,
    },
  );
  assert.equal(firstPageResponse.status, 200);
  const firstPage = (await firstPageResponse.json()) as {
    orderedItems?: string[];
    next?: string;
  };
  assert.equal(firstPage.orderedItems?.length, 20);
  assert.ok(firstPage.next);
  const secondPageResponse = await federation.fetch(
    new Request(firstPage.next as string, { headers }),
    {
      contextData: undefined,
    },
  );
  assert.equal(secondPageResponse.status, 200);
  const secondPage = (await secondPageResponse.json()) as { orderedItems?: string[] };
  assert.equal(secondPage.orderedItems?.length, 5);
  for (const actorUri of [...(firstPage.orderedItems ?? []), ...(secondPage.orderedItems ?? [])]) {
    assert.match(actorUri, /^https:\/\/remote\.example\/users\/page-\d+$/);
  }
});

function restoreEnv(name: 'ACTIVITYPUB_RUN_DB_TESTS' | 'NODE_ENV', previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

const testFederationInput = {
  canonicalOrigin,
  repository: createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin }),
  kv: new MemoryKvStore(),
  queue: createQueue(),
};

test('createTestActivityPubFederation rejects production runtime', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  try {
    await assert.rejects(
      () => createTestActivityPubFederation(testFederationInput),
      (error: unknown) => {
        assert.ok(error instanceof ActivityPubTestRuntimeDisabledError);
        return true;
      },
    );
  } finally {
    restoreEnv('NODE_ENV', previousNodeEnv);
  }
});

test('createTestActivityPubFederation rejects allowPrivateAddress without ACTIVITYPUB_RUN_DB_TESTS', async () => {
  const previousDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  delete process.env.ACTIVITYPUB_RUN_DB_TESTS;

  try {
    await assert.rejects(
      () =>
        createTestActivityPubFederation({
          ...testFederationInput,
          allowPrivateAddress: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ActivityPubTestRuntimeDisabledError);
        return true;
      },
    );
  } finally {
    restoreEnv('ACTIVITYPUB_RUN_DB_TESTS', previousDbTests);
  }
});
