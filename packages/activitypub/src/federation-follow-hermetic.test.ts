import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryKvStore } from '@fedify/fedify';
import { createProductionActivityPubFederation } from './federation.ts';
import {
  deliverOutboxAcceptToVerifiedInboundListener,
  deliverOutboxFollowToVerifiedInboundListener,
  deliverOutboxUndoToVerifiedInboundListener,
  readActivityFromFedifyQueueMessage,
} from './follow-inbox-listener-harness.ts';
import { createActivityPubFollowUseCases } from './follow-use-cases.ts';
import { createInMemoryActivityPubRepository } from './in-memory-actor-repository.ts';
import { createInMemoryActivityPubFollowRepository } from './in-memory-follow-repository.ts';
import { createRemoteActorResolver } from './remote-actor.ts';
import { buildActivityPubUriContract } from './uri-contract.ts';

const canonicalOriginA = 'https://a.lens.test';
const canonicalOriginB = 'https://b.lens.test';
const canonicalOrigin = canonicalOriginA;
const encryptionKey = Buffer.alloc(32, 2);
const projectAId = '10000000-0000-0000-0000-00000000000a';
const projectBId = '10000000-0000-0000-0000-00000000000b';

async function createInstancePair() {
  const actorRepositoryA = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin: canonicalOriginA,
  });
  const actorRepositoryB = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin: canonicalOriginB,
  });
  actorRepositoryA.seedProject({
    id: projectAId,
    slug: 'project-a',
    name: 'Project A',
    visibility: 'public',
  });
  actorRepositoryB.seedProject({
    id: projectBId,
    slug: 'project-b',
    name: 'Project B',
    visibility: 'public',
  });
  const actorA = await actorRepositoryA.seedProjectActor({
    projectId: projectAId,
    projectSlug: 'project-a',
    preferredUsername: 'project-a',
    visibility: 'public',
    enabled: true,
  });
  const actorB = await actorRepositoryB.seedProjectActor({
    projectId: projectBId,
    projectSlug: 'project-b',
    preferredUsername: 'project-b',
    visibility: 'public',
    enabled: true,
  });
  const followRepositoryA = createInMemoryActivityPubFollowRepository();
  const followRepositoryB = createInMemoryActivityPubFollowRepository();
  followRepositoryA.seedActorProject(actorA.id, projectAId);
  followRepositoryB.seedActorProject(actorB.id, projectBId);
  const queueA: unknown[] = [];
  const queueB: unknown[] = [];
  const useCasesA = createActivityPubFollowUseCases({
    canonicalOrigin: canonicalOriginA,
    repository: followRepositoryA,
    actorRepository: actorRepositoryA,
    remoteActorResolver: {
      resolve: async () => ({
        actorUri: `${canonicalOriginB}/activitypub/actors/project-b`,
        inboxUri: `${canonicalOriginB}/activitypub/actors/project-b/inbox`,
        sharedInboxUri: null,
      }),
    },
    testQueue: {
      nativeRetrial: true,
      async enqueue(message) {
        queueA.push(message);
      },
      async listen() {
        await new Promise<void>(() => undefined);
      },
    },
  });
  const useCasesB = createActivityPubFollowUseCases({
    canonicalOrigin: canonicalOriginB,
    repository: followRepositoryB,
    actorRepository: actorRepositoryB,
    remoteActorResolver: {
      resolve: async () => ({
        actorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
        inboxUri: `${canonicalOriginA}/activitypub/actors/project-a/inbox`,
        sharedInboxUri: null,
      }),
    },
    testQueue: {
      nativeRetrial: true,
      async enqueue(message) {
        queueB.push(message);
      },
      async listen() {
        await new Promise<void>(() => undefined);
      },
    },
  });
  return {
    actorA,
    actorB,
    actorRepositoryA,
    actorRepositoryB,
    useCasesA,
    useCasesB,
    followRepositoryA,
    followRepositoryB,
    queueA,
    queueB,
  };
}

test('hermetic A/B one-way follow delivery via fixture bridge becomes accepted', async () => {
  const {
    actorA,
    actorB,
    actorRepositoryA,
    actorRepositoryB,
    useCasesA,
    useCasesB,
    followRepositoryA,
    queueA,
    queueB,
  } = await createInstancePair();
  const outbound = await useCasesA.requestOutboundFollow({
    projectSlug: 'project-a',
    localActorId: actorA.id,
    localActorPreferredUsername: 'project-a',
    localActorKeyId: `${canonicalOriginA}/activitypub/actors/project-a#main-key`,
    remoteActorAddress: `${canonicalOriginB}/activitypub/actors/project-b`,
  });
  assert.equal(outbound.follow.status, 'pending');
  assert.equal(queueA.length, 1);
  await deliverOutboxFollowToVerifiedInboundListener({
    queueMessage: queueA[0],
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  assert.equal(queueB.length, 1);
  await deliverOutboxAcceptToVerifiedInboundListener({
    queueMessage: queueB[0],
    canonicalOrigin: canonicalOriginA,
    actorRepository: actorRepositoryA,
    followUseCases: useCasesA,
    signedActorUri: `${canonicalOriginB}/activitypub/actors/project-b`,
    recipientUsername: 'project-a',
  });
  const accepted = await followRepositoryA.listAcceptedFollows({
    localActorId: actorA.id,
    direction: 'outbound',
  });
  assert.equal(accepted.items[0]?.status, 'accepted');
  void actorB;
});

test('hermetic A/B one-way undo delivery clears inbound followers on B', async () => {
  const {
    actorA,
    actorB,
    actorRepositoryA,
    actorRepositoryB,
    useCasesA,
    useCasesB,
    followRepositoryB,
    queueA,
    queueB,
  } = await createInstancePair();
  await useCasesA.requestOutboundFollow({
    projectSlug: 'project-a',
    localActorId: actorA.id,
    localActorPreferredUsername: 'project-a',
    localActorKeyId: `${canonicalOriginA}/activitypub/actors/project-a#main-key`,
    remoteActorAddress: `${canonicalOriginB}/activitypub/actors/project-b`,
  });
  await deliverOutboxFollowToVerifiedInboundListener({
    queueMessage: queueA[0],
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  await deliverOutboxAcceptToVerifiedInboundListener({
    queueMessage: queueB[0],
    canonicalOrigin: canonicalOriginA,
    actorRepository: actorRepositoryA,
    followUseCases: useCasesA,
    signedActorUri: `${canonicalOriginB}/activitypub/actors/project-b`,
    recipientUsername: 'project-a',
  });
  const undone = await useCasesA.requestOutboundUndo({
    projectSlug: 'project-a',
    localActorId: actorA.id,
    localActorPreferredUsername: 'project-a',
    localActorKeyId: `${canonicalOriginA}/activitypub/actors/project-a#main-key`,
    remoteActorUri: `${canonicalOriginB}/activitypub/actors/project-b`,
    remoteInboxUri: `${canonicalOriginB}/activitypub/actors/project-b/inbox`,
    remoteSharedInboxUri: null,
  });
  assert.equal(undone?.follow.status, 'undone');
  assert.equal(queueA.length, 2);
  await deliverOutboxUndoToVerifiedInboundListener({
    queueMessage: queueA[1],
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  assert.equal(
    (await followRepositoryB.listAcceptedFollows({ localActorId: actorB.id, direction: 'inbound' }))
      .items.length,
    0,
  );
});

test('hermetic duplicate Accept delivery has no duplicate side effects', async () => {
  const {
    actorA,
    actorRepositoryA,
    actorRepositoryB,
    useCasesA,
    useCasesB,
    followRepositoryA,
    queueA,
    queueB,
  } = await createInstancePair();
  await useCasesA.requestOutboundFollow({
    projectSlug: 'project-a',
    localActorId: actorA.id,
    localActorPreferredUsername: 'project-a',
    localActorKeyId: `${canonicalOriginA}/activitypub/actors/project-a#main-key`,
    remoteActorAddress: `${canonicalOriginB}/activitypub/actors/project-b`,
  });
  await deliverOutboxFollowToVerifiedInboundListener({
    queueMessage: queueA[0],
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  const acceptDelivery = {
    queueMessage: queueB[0],
    canonicalOrigin: canonicalOriginA,
    actorRepository: actorRepositoryA,
    followUseCases: useCasesA,
    signedActorUri: `${canonicalOriginB}/activitypub/actors/project-b`,
    recipientUsername: 'project-a',
  };
  await deliverOutboxAcceptToVerifiedInboundListener(acceptDelivery);
  await deliverOutboxAcceptToVerifiedInboundListener(acceptDelivery);
  assert.equal(
    (
      await followRepositoryA.listAcceptedFollows({
        localActorId: actorA.id,
        direction: 'outbound',
      })
    ).items[0]?.status,
    'accepted',
  );
  assert.equal(queueB.length, 1);
  assert.equal(queueA.length, 1);
});

test('hermetic stale undo after re-follow keeps new generation accepted on B', async () => {
  const {
    actorA,
    actorB,
    actorRepositoryA,
    actorRepositoryB,
    useCasesA,
    useCasesB,
    followRepositoryB,
    queueA,
    queueB,
  } = await createInstancePair();
  const firstFollow = await useCasesA.requestOutboundFollow({
    projectSlug: 'project-a',
    localActorId: actorA.id,
    localActorPreferredUsername: 'project-a',
    localActorKeyId: `${canonicalOriginA}/activitypub/actors/project-a#main-key`,
    remoteActorAddress: `${canonicalOriginB}/activitypub/actors/project-b`,
  });
  const staleFollowUri = firstFollow.follow.followActivityUri;
  await deliverOutboxFollowToVerifiedInboundListener({
    queueMessage: queueA[0],
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  await deliverOutboxAcceptToVerifiedInboundListener({
    queueMessage: queueB[0],
    canonicalOrigin: canonicalOriginA,
    actorRepository: actorRepositoryA,
    followUseCases: useCasesA,
    signedActorUri: `${canonicalOriginB}/activitypub/actors/project-b`,
    recipientUsername: 'project-a',
  });
  await useCasesA.requestOutboundUndo({
    projectSlug: 'project-a',
    localActorId: actorA.id,
    localActorPreferredUsername: 'project-a',
    localActorKeyId: `${canonicalOriginA}/activitypub/actors/project-a#main-key`,
    remoteActorUri: `${canonicalOriginB}/activitypub/actors/project-b`,
    remoteInboxUri: `${canonicalOriginB}/activitypub/actors/project-b/inbox`,
    remoteSharedInboxUri: null,
  });
  await deliverOutboxUndoToVerifiedInboundListener({
    queueMessage: queueA[1],
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  await useCasesA.requestOutboundFollow({
    projectSlug: 'project-a',
    localActorId: actorA.id,
    localActorPreferredUsername: 'project-a',
    localActorKeyId: `${canonicalOriginA}/activitypub/actors/project-a#main-key`,
    remoteActorAddress: `${canonicalOriginB}/activitypub/actors/project-b`,
  });
  await deliverOutboxFollowToVerifiedInboundListener({
    queueMessage: queueA[2],
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  await deliverOutboxAcceptToVerifiedInboundListener({
    queueMessage: queueB[1],
    canonicalOrigin: canonicalOriginA,
    actorRepository: actorRepositoryA,
    followUseCases: useCasesA,
    signedActorUri: `${canonicalOriginB}/activitypub/actors/project-b`,
    recipientUsername: 'project-a',
  });
  await deliverOutboxUndoToVerifiedInboundListener({
    queueMessage: {
      activity: {
        type: 'Undo',
        id: `${canonicalOriginA}/activitypub/activities/undo/stale-after-refollow`,
        actor: `${canonicalOriginA}/activitypub/actors/project-a`,
        object: {
          type: 'Follow',
          id: staleFollowUri,
          actor: `${canonicalOriginA}/activitypub/actors/project-a`,
          object: `${canonicalOriginB}/activitypub/actors/project-b`,
        },
      },
    },
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  assert.equal(
    (await followRepositoryB.listAcceptedFollows({ localActorId: actorB.id, direction: 'inbound' }))
      .items[0]?.status,
    'accepted',
  );
  void actorB;
});

test('hermetic A/B mutual follow delivery via fixture bridge accepts on both sides', async () => {
  const {
    actorA,
    actorB,
    actorRepositoryA,
    actorRepositoryB,
    useCasesA,
    useCasesB,
    followRepositoryA,
    followRepositoryB,
    queueA,
    queueB,
  } = await createInstancePair();

  const aFollowsB = await useCasesA.requestOutboundFollow({
    projectSlug: 'project-a',
    localActorId: actorA.id,
    localActorPreferredUsername: 'project-a',
    localActorKeyId: `${canonicalOriginA}/activitypub/actors/project-a#main-key`,
    remoteActorAddress: `${canonicalOriginB}/activitypub/actors/project-b`,
  });
  await deliverOutboxFollowToVerifiedInboundListener({
    queueMessage: queueA[0],
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  await deliverOutboxAcceptToVerifiedInboundListener({
    queueMessage: queueB[0],
    canonicalOrigin: canonicalOriginA,
    actorRepository: actorRepositoryA,
    followUseCases: useCasesA,
    signedActorUri: `${canonicalOriginB}/activitypub/actors/project-b`,
    recipientUsername: 'project-a',
  });

  const bFollowsA = await useCasesB.requestOutboundFollow({
    projectSlug: 'project-b',
    localActorId: actorB.id,
    localActorPreferredUsername: 'project-b',
    localActorKeyId: `${canonicalOriginB}/activitypub/actors/project-b#main-key`,
    remoteActorAddress: `${canonicalOriginA}/activitypub/actors/project-a`,
  });
  await deliverOutboxFollowToVerifiedInboundListener({
    queueMessage: queueB[1],
    canonicalOrigin: canonicalOriginA,
    actorRepository: actorRepositoryA,
    followUseCases: useCasesA,
    signedActorUri: `${canonicalOriginB}/activitypub/actors/project-b`,
    recipientUsername: 'project-a',
  });
  await deliverOutboxAcceptToVerifiedInboundListener({
    queueMessage: queueA[1],
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });

  assert.equal(
    (
      await followRepositoryA.listAcceptedFollows({
        localActorId: actorA.id,
        direction: 'outbound',
      })
    ).items[0]?.status,
    'accepted',
  );
  assert.equal(
    (
      await followRepositoryB.listAcceptedFollows({
        localActorId: actorB.id,
        direction: 'outbound',
      })
    ).items[0]?.status,
    'accepted',
  );

  const repeat = await useCasesA.requestOutboundFollow({
    projectSlug: 'project-a',
    localActorId: actorA.id,
    localActorPreferredUsername: 'project-a',
    localActorKeyId: `${canonicalOriginA}/activitypub/actors/project-a#main-key`,
    remoteActorAddress: `${canonicalOriginB}/activitypub/actors/project-b`,
  });
  assert.equal(repeat.enqueued, false);
  assert.equal(queueA.length, 2);
  assert.equal(queueB.length, 2);
  void aFollowsB;
  void bFollowsA;
});

test('hermetic duplicate inbound follow delivery has no duplicate side effects', async () => {
  const { actorB, actorRepositoryB, useCasesB, queueB } = await createInstancePair();
  const followActivityUri = `${canonicalOriginB}/activitypub/activities/follow/duplicate-hermetic`;
  const followDelivery = {
    queueMessage: {
      activity: {
        type: 'Follow',
        id: followActivityUri,
        actor: `${canonicalOriginA}/activitypub/actors/project-a`,
        object: `${canonicalOriginB}/activitypub/actors/project-b`,
      },
    },
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  };
  await deliverOutboxFollowToVerifiedInboundListener(followDelivery);
  assert.equal(queueB.length, 1);
  await deliverOutboxFollowToVerifiedInboundListener(followDelivery);
  assert.equal(queueB.length, 1);
  void actorB;
});

test('hermetic reordered undo-before-follow delivery tombstones stale follow activity id', async () => {
  const { actorB, actorRepositoryB, useCasesB, followRepositoryB, queueB } =
    await createInstancePair();
  const followActivityUri = `${canonicalOriginB}/activitypub/activities/follow/reorder-hermetic`;
  await deliverOutboxUndoToVerifiedInboundListener({
    queueMessage: {
      activity: {
        type: 'Undo',
        id: `${canonicalOriginB}/activitypub/activities/undo/reorder-hermetic`,
        actor: `${canonicalOriginA}/activitypub/actors/project-a`,
        object: {
          type: 'Follow',
          id: followActivityUri,
          actor: `${canonicalOriginA}/activitypub/actors/project-a`,
          object: `${canonicalOriginB}/activitypub/actors/project-b`,
        },
      },
    },
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  await deliverOutboxFollowToVerifiedInboundListener({
    queueMessage: {
      activity: {
        type: 'Follow',
        id: followActivityUri,
        actor: `${canonicalOriginA}/activitypub/actors/project-a`,
        object: `${canonicalOriginB}/activitypub/actors/project-b`,
      },
    },
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  assert.equal(
    (await followRepositoryB.listAcceptedFollows({ localActorId: actorB.id, direction: 'inbound' }))
      .items.length,
    0,
  );
  assert.equal(queueB.length, 0);
});

test('hermetic inbound follow after undo delivery accepts new generation with different activity id', async () => {
  const { actorB, actorRepositoryB, useCasesB, followRepositoryB, queueB } =
    await createInstancePair();
  const staleFollowUri = `${canonicalOriginB}/activitypub/activities/follow/reorder-stale`;
  await deliverOutboxUndoToVerifiedInboundListener({
    queueMessage: {
      activity: {
        type: 'Undo',
        id: `${canonicalOriginB}/activitypub/activities/undo/reorder-stale`,
        actor: `${canonicalOriginA}/activitypub/actors/project-a`,
        object: {
          type: 'Follow',
          id: staleFollowUri,
          actor: `${canonicalOriginA}/activitypub/actors/project-a`,
          object: `${canonicalOriginB}/activitypub/actors/project-b`,
        },
      },
    },
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  const newFollowUri = `${canonicalOriginB}/activitypub/activities/follow/reorder-new`;
  await deliverOutboxFollowToVerifiedInboundListener({
    queueMessage: {
      activity: {
        type: 'Follow',
        id: newFollowUri,
        actor: `${canonicalOriginA}/activitypub/actors/project-a`,
        object: `${canonicalOriginB}/activitypub/actors/project-b`,
      },
    },
    canonicalOrigin: canonicalOriginB,
    actorRepository: actorRepositoryB,
    followUseCases: useCasesB,
    signedActorUri: `${canonicalOriginA}/activitypub/actors/project-a`,
    recipientUsername: 'project-b',
  });
  assert.equal(
    (await followRepositoryB.listAcceptedFollows({ localActorId: actorB.id, direction: 'inbound' }))
      .items[0]?.status,
    'accepted',
  );
  assert.equal(queueB.length, 1);
});

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
}

function createMastodonResponseMap(
  mastodonOrigin: string,
  mastodonActor: string,
  mastodonInbox: string,
) {
  const responses = new Map<string, Response>();
  responses.set(
    `${mastodonOrigin}/.well-known/webfinger?resource=${encodeURIComponent('acct:alice@mastodon.fixture.example')}`,
    new Response(
      JSON.stringify({
        subject: 'acct:alice@mastodon.fixture.example',
        links: [
          {
            rel: 'self',
            type: 'application/activity+json',
            href: mastodonActor,
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/jrd+json' } },
    ),
  );
  responses.set(
    mastodonActor,
    new Response(
      JSON.stringify({
        id: mastodonActor,
        type: 'Service',
        inbox: mastodonInbox,
      }),
      { status: 200, headers: { 'content-type': 'application/activity+json' } },
    ),
  );
  return responses;
}

test('hermetic mastodon client resolves local actors via production federation fetch', async () => {
  const repository = createInMemoryActivityPubRepository({ encryptionKey, canonicalOrigin });
  await repository.seedAggregateActor();
  repository.seedProject({
    id: projectAId,
    slug: 'sample-project',
    name: 'Sample',
    visibility: 'public',
  });
  const projectActor = await repository.seedProjectActor({
    projectId: projectAId,
    projectSlug: 'sample-project',
    preferredUsername: 'sample-project',
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
  await assertRemotelyVisibleActorContract(fetch, uri, projectActor.preferredUsername);
});

test('hermetic mastodon fixture resolves remote actor and completes outbound follow delivery', async () => {
  const mastodonOrigin = 'https://mastodon.fixture.example';
  const mastodonActor = `${mastodonOrigin}/users/alice`;
  const mastodonInbox = `${mastodonActor}/inbox`;
  const responses = createMastodonResponseMap(mastodonOrigin, mastodonActor, mastodonInbox);
  const actorRepository = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin,
  });
  actorRepository.seedProject({
    id: projectAId,
    slug: 'sample-project',
    name: 'Sample',
    visibility: 'public',
  });
  const actor = await actorRepository.seedProjectActor({
    projectId: projectAId,
    projectSlug: 'sample-project',
    preferredUsername: 'sample-project',
    visibility: 'public',
    enabled: true,
  });
  const followRepository = createInMemoryActivityPubFollowRepository();
  followRepository.seedActorProject(actor.id, projectAId);
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async (url) => {
      const key = typeof url === 'string' ? url : url.toString();
      const response = responses.get(key);
      return response ? response.clone() : new Response('not found', { status: 404 });
    },
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });
  const queue: unknown[] = [];
  const useCases = createActivityPubFollowUseCases({
    canonicalOrigin,
    repository: followRepository,
    actorRepository,
    remoteActorResolver: resolver,
    testQueue: {
      nativeRetrial: true,
      async enqueue(message) {
        queue.push(message);
      },
      async listen() {
        await new Promise<void>(() => undefined);
      },
    },
  });
  const outbound = await useCases.requestOutboundFollow({
    projectSlug: 'sample-project',
    localActorId: actor.id,
    localActorPreferredUsername: 'sample-project',
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/sample-project#main-key`,
    remoteActorAddress: 'acct:alice@mastodon.fixture.example',
  });
  assert.equal(outbound.follow.status, 'pending');
  assert.equal(queue.length, 1);
  await deliverOutboxAcceptToVerifiedInboundListener({
    queueMessage: {
      activity: {
        type: 'Accept',
        id: `${mastodonActor}/activities/accept/mastodon-outbound`,
        actor: mastodonActor,
        object: {
          type: 'Follow',
          id: outbound.follow.followActivityUri,
          actor: `${canonicalOrigin}/activitypub/actors/sample-project`,
          object: mastodonActor,
        },
      },
    },
    canonicalOrigin,
    actorRepository,
    followUseCases: useCases,
    signedActorUri: mastodonActor,
    recipientUsername: 'sample-project',
  });
  const accepted = await followRepository.listAcceptedFollows({
    localActorId: actor.id,
    direction: 'outbound',
  });
  assert.equal(accepted.items[0]?.status, 'accepted');
  const undone = await useCases.requestOutboundUndo({
    projectSlug: 'sample-project',
    localActorId: actor.id,
    localActorPreferredUsername: 'sample-project',
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/sample-project#main-key`,
    remoteActorUri: mastodonActor,
    remoteInboxUri: mastodonInbox,
    remoteSharedInboxUri: null,
  });
  assert.equal(undone?.follow.status, 'undone');
  assert.equal(queue.length, 2);
});

test('hermetic mastodon inbound follow delivery for project and aggregate actors', async () => {
  const mastodonOrigin = 'https://mastodon.fixture.example';
  const mastodonActor = `${mastodonOrigin}/users/alice`;
  const mastodonInbox = `${mastodonActor}/inbox`;
  const responses = createMastodonResponseMap(mastodonOrigin, mastodonActor, mastodonInbox);
  const actorRepository = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin,
  });
  await actorRepository.seedAggregateActor();
  actorRepository.seedProject({
    id: projectAId,
    slug: 'sample-project',
    name: 'Sample',
    visibility: 'public',
  });
  const projectActor = await actorRepository.seedProjectActor({
    projectId: projectAId,
    projectSlug: 'sample-project',
    preferredUsername: 'sample-project',
    visibility: 'public',
    enabled: true,
  });
  const aggregateActor = await actorRepository.findRemotelyVisibleActorByUsername('all');
  if (!aggregateActor) {
    throw new Error('aggregate actor missing');
  }
  const followRepository = createInMemoryActivityPubFollowRepository();
  followRepository.seedActorProject(projectActor.id, projectAId);
  followRepository.seedActorProject(aggregateActor.id, projectAId);
  const resolver = createRemoteActorResolver({
    canonicalOrigin,
    fetch: async (url) => {
      const key = typeof url === 'string' ? url : url.toString();
      const response = responses.get(key);
      return response ? response.clone() : new Response('not found', { status: 404 });
    },
    isDomainBlocked: () => false,
    validateUrl: async () => {},
  });
  const queue: unknown[] = [];
  const useCases = createActivityPubFollowUseCases({
    canonicalOrigin,
    repository: followRepository,
    actorRepository,
    remoteActorResolver: resolver,
    testQueue: {
      nativeRetrial: true,
      async enqueue(message) {
        queue.push(message);
      },
      async listen() {
        await new Promise<void>(() => undefined);
      },
    },
  });
  for (const actor of [projectActor, aggregateActor]) {
    const inboundFollowUri = `${mastodonActor}/activities/follow-${actor.preferredUsername}`;
    await deliverOutboxFollowToVerifiedInboundListener({
      queueMessage: {
        activity: {
          type: 'Follow',
          id: inboundFollowUri,
          actor: mastodonActor,
          object: `${canonicalOrigin}/activitypub/actors/${actor.preferredUsername}`,
        },
      },
      canonicalOrigin,
      actorRepository,
      followUseCases: useCases,
      signedActorUri: mastodonActor,
      recipientUsername: actor.preferredUsername,
    });
    const acceptActivity = readActivityFromFedifyQueueMessage(queue[queue.length - 1]) as {
      type: string;
      actor: string;
      object: { type: string; actor: string; object: string };
    };
    assert.equal(acceptActivity.type, 'Accept');
    assert.equal(
      acceptActivity.actor,
      `${canonicalOrigin}/activitypub/actors/${actor.preferredUsername}`,
    );
    assert.equal(acceptActivity.object.type, 'Follow');
    assert.equal(acceptActivity.object.actor, mastodonActor);
    assert.equal(
      acceptActivity.object.object,
      `${canonicalOrigin}/activitypub/actors/${actor.preferredUsername}`,
    );
    await deliverOutboxUndoToVerifiedInboundListener({
      queueMessage: {
        activity: {
          type: 'Undo',
          id: `${mastodonActor}/activities/undo-${actor.preferredUsername}`,
          actor: mastodonActor,
          object: {
            type: 'Follow',
            id: inboundFollowUri,
            actor: mastodonActor,
            object: `${canonicalOrigin}/activitypub/actors/${actor.preferredUsername}`,
          },
        },
      },
      canonicalOrigin,
      actorRepository,
      followUseCases: useCases,
      signedActorUri: mastodonActor,
      recipientUsername: actor.preferredUsername,
    });
    assert.equal(
      (await followRepository.listAcceptedFollows({ localActorId: actor.id, direction: 'inbound' }))
        .items.length,
      0,
    );
  }
  assert.equal(queue.length, 2);
});
