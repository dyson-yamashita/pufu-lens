import assert from 'node:assert/strict';
import test from 'node:test';
import type { InboxContext } from '@fedify/fedify';
import {
  createVerifiedInboxContextForTest,
  invokeVerifiedInboundFollowListenerForTest,
} from './federation-follow-listeners.ts';
import { buildFollowActivityFromJson } from './follow-inbox-listener-harness.ts';
import { createActivityPubFollowUseCases } from './follow-use-cases.ts';
import { createInMemoryActivityPubRepository } from './in-memory-actor-repository.ts';
import { createInMemoryActivityPubFollowRepository } from './in-memory-follow-repository.ts';

const canonicalOrigin = 'https://lens.test';
const encryptionKey = Buffer.alloc(32, 3);
const projectId = '10000000-0000-0000-0000-000000000001';
const projectSlug = 'sample-project';
const localActorUri = `${canonicalOrigin}/activitypub/actors/${projectSlug}`;
const remoteActorUri = 'https://remote.example/users/alice';
const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/listener-contract`;

async function createListenerFixture() {
  const actorRepository = createInMemoryActivityPubRepository({
    encryptionKey,
    canonicalOrigin,
  });
  await actorRepository.seedAggregateActor();
  actorRepository.seedProject({
    id: projectId,
    slug: projectSlug,
    name: 'Sample Project',
    visibility: 'public',
  });
  const actor = await actorRepository.seedProjectActor({
    projectId,
    projectSlug,
    preferredUsername: projectSlug,
    visibility: 'public',
    enabled: true,
  });
  const followRepository = createInMemoryActivityPubFollowRepository();
  followRepository.seedActorProject(actor.id, projectId);
  const followUseCases = createActivityPubFollowUseCases({
    canonicalOrigin,
    repository: followRepository,
    actorRepository,
    remoteActorResolver: {
      resolve: async () => ({
        actorUri: remoteActorUri,
        inboxUri: `${remoteActorUri}/inbox`,
        sharedInboxUri: null,
      }),
    },
  });
  const activity = buildFollowActivityFromJson({
    type: 'Follow',
    id: followActivityUri,
    actor: remoteActorUri,
    object: localActorUri,
  });
  return { actorRepository, followUseCases, activity };
}

test('inbound follow listener processes queued context without getSignedKeyOwner', async () => {
  const { actorRepository, followUseCases, activity } = await createListenerFixture();
  let processed = false;
  const observingUseCases = {
    ...followUseCases,
    processVerifiedInboundFollow: async (
      input: Parameters<typeof followUseCases.processVerifiedInboundFollow>[0],
    ) => {
      processed = true;
      return followUseCases.processVerifiedInboundFollow(input);
    },
  };
  const ctx = {
    recipient: projectSlug,
  } as InboxContext<undefined>;

  await invokeVerifiedInboundFollowListenerForTest({
    canonicalOrigin,
    actorRepository,
    followUseCases: observingUseCases,
    ctx,
    activity,
  });

  assert.equal(processed, true);
});

test('inbound follow listener rejects mismatched signed key owner from test harness hook', async () => {
  const { actorRepository, followUseCases, activity } = await createListenerFixture();
  let processed = false;
  const observingUseCases = {
    ...followUseCases,
    processVerifiedInboundFollow: async (
      input: Parameters<typeof followUseCases.processVerifiedInboundFollow>[0],
    ) => {
      processed = true;
      return followUseCases.processVerifiedInboundFollow(input);
    },
  };
  const ctx = createVerifiedInboxContextForTest({
    recipient: projectSlug,
    signedActorUri: 'https://evil.example/users/not-alice',
  });

  await invokeVerifiedInboundFollowListenerForTest({
    canonicalOrigin,
    actorRepository,
    followUseCases: observingUseCases,
    ctx,
    activity,
  });

  assert.equal(processed, false);
});
