import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivityPubFollowUseCases } from './follow-use-cases.ts';
import { createInMemoryActivityPubRepository } from './in-memory-actor-repository.ts';
import { createInMemoryActivityPubFollowRepository } from './in-memory-follow-repository.ts';

const canonicalOrigin = 'https://lens.test';
const encryptionKey = Buffer.alloc(32, 7);
const projectId = '20000000-0000-0000-0000-000000000001';
const projectSlug = 'sample-project';
const remoteActorUri = 'https://remote.example/users/alice';
const remoteInboxUri = `${remoteActorUri}/inbox`;

async function createFixtureUseCases(input?: { enqueueInterceptor?: () => Promise<void> }) {
  const actorRepository = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin,
  });
  actorRepository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample',
    visibility: 'public',
  });
  await actorRepository.seedProjectActor({
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: true,
  });
  const followRepository = createInMemoryActivityPubFollowRepository();
  const actor = await actorRepository.findRemotelyVisibleActorByUsername(projectSlug);
  if (!actor) {
    throw new Error('fixture actor missing');
  }
  followRepository.seedActorProject(actor.id, projectId);
  const capturedEnqueues: unknown[] = [];
  const queue = {
    nativeRetrial: true as const,
    async enqueue(message: unknown) {
      if (input?.enqueueInterceptor) {
        await input.enqueueInterceptor();
      }
      capturedEnqueues.push(message);
    },
    async listen() {
      await new Promise<void>(() => undefined);
    },
  };
  const useCases = createActivityPubFollowUseCases({
    canonicalOrigin,
    repository: followRepository,
    actorRepository,
    remoteActorResolver: {
      resolve: async () => ({
        actorUri: remoteActorUri,
        inboxUri: remoteInboxUri,
        sharedInboxUri: null,
      }),
    },
    testQueue: queue,
  });
  return { useCases, followRepository, capturedEnqueues, actorRepository, actor };
}

test('processVerifiedInboundFollow enqueues Accept without separate sendActivity', async () => {
  const { useCases, capturedEnqueues, actor } = await createFixtureUseCases();
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/inbound-usecase`;
  const processed = await useCases.processVerifiedInboundFollow({
    localActorId: actor.id,
    localActorPreferredUsername: projectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${projectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${projectSlug}`,
    remoteActorUri,
    remoteInboxUri,
    remoteSharedInboxUri: null,
    followActivityUri,
  });
  assert.equal(processed.processed, true);
  assert.equal(processed.enqueued, true);
  assert.equal(capturedEnqueues.length, 1);
});

test('processVerifiedInboundFollow uses shared inbox recipient when remote actor provides sharedInbox', async () => {
  const sharedInbox = 'https://remote.example/inbox';
  const actorRepository = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin,
  });
  actorRepository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample',
    visibility: 'public',
  });
  await actorRepository.seedProjectActor({
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: true,
  });
  const followRepository = createInMemoryActivityPubFollowRepository();
  const actor = await actorRepository.findRemotelyVisibleActorByUsername(projectSlug);
  if (!actor) {
    throw new Error('fixture actor missing');
  }
  followRepository.seedActorProject(actor.id, projectId);
  const capturedEnqueues: Array<{ inbox?: string; sharedInbox?: boolean }> = [];
  const useCases = createActivityPubFollowUseCases({
    canonicalOrigin,
    repository: followRepository,
    actorRepository,
    remoteActorResolver: {
      resolve: async () => ({
        actorUri: remoteActorUri,
        inboxUri: remoteInboxUri,
        sharedInboxUri: sharedInbox,
      }),
    },
    testQueue: {
      nativeRetrial: true,
      async enqueue(message: unknown) {
        capturedEnqueues.push(message as { inbox?: string; sharedInbox?: boolean });
      },
      async listen() {
        await new Promise<void>(() => undefined);
      },
    },
  });
  await useCases.processVerifiedInboundFollow({
    localActorId: actor.id,
    localActorPreferredUsername: projectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${projectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${projectSlug}`,
    remoteActorUri,
    remoteInboxUri,
    remoteSharedInboxUri: sharedInbox,
    followActivityUri: `${canonicalOrigin}/activitypub/activities/follow/shared-inbox-usecase`,
  });
  assert.equal(capturedEnqueues[0]?.inbox, sharedInbox);
  assert.equal(capturedEnqueues[0]?.sharedInbox, true);
});

test('enqueue failure rolls back outbound follow mutation in transactional use cases', async () => {
  const { useCases, followRepository, actor } = await createFixtureUseCases({
    enqueueInterceptor: async () => {
      throw new Error('enqueue failed');
    },
  });
  await assert.rejects(
    () =>
      useCases.requestOutboundFollow({
        projectSlug,
        localActorId: actor.id,
        localActorPreferredUsername: projectSlug,
        localActorKeyId: `${canonicalOrigin}/activitypub/actors/${projectSlug}#main-key`,
        remoteActorAddress: remoteActorUri,
      }),
    /enqueue failed/,
  );
  const follows = await followRepository.listProjectOutboundFollows({ projectId });
  assert.equal(follows.length, 0);
});
