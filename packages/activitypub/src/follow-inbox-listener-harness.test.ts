import assert from 'node:assert/strict';
import test from 'node:test';
import {
  processStoredInboxViaVerifiedListenerHarness,
  UnsupportedStoredInboxActivityError,
} from './follow-inbox-listener-harness.ts';
import { createActivityPubFollowUseCases } from './follow-use-cases.ts';
import { createInMemoryActivityPubRepository } from './in-memory-actor-repository.ts';
import { createInMemoryActivityPubFollowRepository } from './in-memory-follow-repository.ts';
import { parsePinnedInboxMessage } from './queue.ts';

const canonicalOrigin = 'https://lens.test';
const encryptionKey = Buffer.alloc(32, 4);
const projectId = '10000000-0000-0000-0000-000000000001';
const projectSlug = 'sample-project';
const localActorUri = `${canonicalOrigin}/activitypub/actors/${projectSlug}`;
const remoteActorUri = 'https://remote.example/users/alice';
const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/harness-test`;
const acceptActivityUri = `${canonicalOrigin}/activitypub/activities/accept/harness-test`;
const undoActivityUri = `${canonicalOrigin}/activitypub/activities/undo/harness-test`;

function withDbTestEnv(run: () => Promise<void>): Promise<void> {
  const previousDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.ACTIVITYPUB_RUN_DB_TESTS = '1';
  process.env.NODE_ENV = 'test';
  return run().finally(() => {
    if (previousDbTests === undefined) {
      delete process.env.ACTIVITYPUB_RUN_DB_TESTS;
    } else {
      process.env.ACTIVITYPUB_RUN_DB_TESTS = previousDbTests;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });
}

async function createHarnessFixture() {
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
  return { actorRepository, followUseCases };
}

test('processStoredInboxViaVerifiedListenerHarness dispatches Accept activities', async () => {
  await withDbTestEnv(async () => {
    const { actorRepository, followUseCases } = await createHarnessFixture();
    let accepted = false;
    const observingUseCases = {
      ...followUseCases,
      processVerifiedInboundAccept: async (
        input: Parameters<typeof followUseCases.processVerifiedInboundAccept>[0],
      ) => {
        accepted = true;
        return followUseCases.processVerifiedInboundAccept(input);
      },
    };
    const stored = parsePinnedInboxMessage({
      type: 'inbox',
      id: 'inbox-msg-accept',
      baseUrl: canonicalOrigin,
      activity: {
        type: 'Accept',
        id: acceptActivityUri,
        actor: remoteActorUri,
        object: {
          type: 'Follow',
          id: followActivityUri,
          actor: localActorUri,
          object: remoteActorUri,
        },
      },
      started: '2026-08-01T00:00:00.000Z',
      attempt: 0,
      identifier: projectSlug,
      traceContext: {},
    });
    await processStoredInboxViaVerifiedListenerHarness({
      stored,
      canonicalOrigin,
      actorRepository,
      followUseCases: observingUseCases,
      signedActorUri: remoteActorUri,
    });
    assert.equal(accepted, true);
  });
});

test('processStoredInboxViaVerifiedListenerHarness dispatches Undo activities', async () => {
  await withDbTestEnv(async () => {
    const { actorRepository, followUseCases } = await createHarnessFixture();
    let undone = false;
    const observingUseCases = {
      ...followUseCases,
      processVerifiedInboundUndo: async (
        input: Parameters<typeof followUseCases.processVerifiedInboundUndo>[0],
      ) => {
        undone = true;
        return followUseCases.processVerifiedInboundUndo(input);
      },
    };
    const stored = parsePinnedInboxMessage({
      type: 'inbox',
      id: 'inbox-msg-undo',
      baseUrl: canonicalOrigin,
      activity: {
        type: 'Undo',
        id: undoActivityUri,
        actor: remoteActorUri,
        object: {
          type: 'Follow',
          id: followActivityUri,
          actor: remoteActorUri,
          object: localActorUri,
        },
      },
      started: '2026-08-01T00:00:00.000Z',
      attempt: 0,
      identifier: projectSlug,
      traceContext: {},
    });
    await processStoredInboxViaVerifiedListenerHarness({
      stored,
      canonicalOrigin,
      actorRepository,
      followUseCases: observingUseCases,
      signedActorUri: remoteActorUri,
    });
    assert.equal(undone, true);
  });
});

test('processStoredInboxViaVerifiedListenerHarness rejects unsupported inbox activity types', async () => {
  await withDbTestEnv(async () => {
    const { actorRepository, followUseCases } = await createHarnessFixture();
    const stored = parsePinnedInboxMessage({
      type: 'inbox',
      id: 'inbox-msg-create',
      baseUrl: canonicalOrigin,
      activity: {
        type: 'Create',
        id: `${canonicalOrigin}/activitypub/activities/create/harness-test`,
        actor: remoteActorUri,
        object: localActorUri,
      },
      started: '2026-08-01T00:00:00.000Z',
      attempt: 0,
      identifier: projectSlug,
      traceContext: {},
    });
    await assert.rejects(
      () =>
        processStoredInboxViaVerifiedListenerHarness({
          stored,
          canonicalOrigin,
          actorRepository,
          followUseCases,
          signedActorUri: remoteActorUri,
        }),
      (error: unknown) => error instanceof UnsupportedStoredInboxActivityError,
    );
  });
});
