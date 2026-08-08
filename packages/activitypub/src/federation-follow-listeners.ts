import type { FederationBuilder, InboxContext } from '@fedify/fedify';
import { Accept, Follow, Undo } from '@fedify/vocab';
import type { ActivityPubRepository } from './actor-repository.ts';
import { normalizeRemoteActorUri } from './follow-model.ts';
import type { ActivityPubFollowUseCases } from './follow-use-cases.ts';
import type { ActivityPubActor } from './schema.ts';
import { assertActivityPubListenerHarnessRuntime } from './test-runtime-guard.ts';
import { buildActivityPubUriContract } from './uri-contract.ts';

type InboxContextWithSignedKeyOwner = InboxContext<undefined> & {
  getSignedKeyOwner(): Promise<{ id?: URL | null } | null>;
};

/** Registers verified Follow/Accept/Undo inbox listeners on personal and shared inboxes. */
export function registerFollowInboxListeners(
  builder: FederationBuilder<undefined>,
  input: {
    canonicalOrigin: string;
    actorRepository: ActivityPubRepository;
    followUseCases: ActivityPubFollowUseCases;
  },
): void {
  const uri = buildActivityPubUriContract(input.canonicalOrigin);
  const listeners = builder
    .setInboxListeners('/activitypub/actors/{identifier}/inbox', '/activitypub/inbox')
    .withIdempotency('global');

  listeners.on(Follow, async (ctx, activity) => {
    await handleInboundFollow(ctx, activity, input, uri);
  });
  listeners.on(Accept, async (ctx, activity) => {
    await handleInboundAccept(ctx, activity, input, uri);
  });
  listeners.on(Undo, async (ctx, activity) => {
    await handleInboundUndo(ctx, activity, input, uri);
  });
}

async function handleInboundFollow(
  ctx: InboxContext<undefined>,
  activity: Follow,
  input: {
    canonicalOrigin: string;
    actorRepository: ActivityPubRepository;
    followUseCases: ActivityPubFollowUseCases;
  },
  uri: ReturnType<typeof buildActivityPubUriContract>,
): Promise<void> {
  const followActivityUri = readRequiredHttpsUrl(activity.id, 'Follow id');
  const remoteActorUri = normalizeRemoteActorUri(
    readRequiredHttpsUrl(activity.actorId, 'Follow actor'),
  );
  const localActorUri = readRequiredHttpsUrl(activity.objectId, 'Follow object');

  if (!(await assertVerifiedActor(ctx, remoteActorUri))) {
    return;
  }

  const localActor = await resolveLocalActor(input.actorRepository, {
    recipient: ctx.recipient,
    objectUrl: localActorUri,
  });
  if (!localActor || uri.actorUrl(localActor.preferredUsername) !== localActorUri) {
    return;
  }

  const remote = await input.followUseCases.resolveRemoteActor(remoteActorUri);
  if (normalizeRemoteActorUri(remote.actorUri) !== remoteActorUri) {
    return;
  }

  await input.followUseCases.processVerifiedInboundFollow({
    localActorId: localActor.id,
    localActorPreferredUsername: localActor.preferredUsername,
    localActorKeyId: uri.actorKeyId(localActor.preferredUsername),
    localActorUri,
    remoteActorUri: remote.actorUri,
    remoteInboxUri: remote.inboxUri,
    remoteSharedInboxUri: remote.sharedInboxUri,
    followActivityUri,
  });
}

async function handleInboundAccept(
  ctx: InboxContext<undefined>,
  activity: Accept,
  input: {
    canonicalOrigin: string;
    actorRepository: ActivityPubRepository;
    followUseCases: ActivityPubFollowUseCases;
  },
  uri: ReturnType<typeof buildActivityPubUriContract>,
): Promise<void> {
  const acceptActivityUri = readRequiredHttpsUrl(activity.id, 'Accept id');
  const remoteActorUri = normalizeRemoteActorUri(
    readRequiredHttpsUrl(activity.actorId, 'Accept actor'),
  );
  const embeddedFollow = await activity.getObject();
  if (!(embeddedFollow instanceof Follow)) {
    return;
  }
  const followActivityUri = readRequiredHttpsUrl(embeddedFollow.id, 'Accept object Follow id');
  const embeddedFollowActor = readRequiredHttpsUrl(
    embeddedFollow.actorId,
    'Accept embedded Follow actor',
  );
  const embeddedFollowObject = readRequiredHttpsUrl(
    embeddedFollow.objectId,
    'Accept embedded Follow object',
  );

  if (!(await assertVerifiedActor(ctx, remoteActorUri))) {
    return;
  }

  const localActor = await resolveLocalActor(input.actorRepository, {
    recipient: ctx.recipient,
    objectUrl: embeddedFollowActor,
  });
  if (!localActor || uri.actorUrl(localActor.preferredUsername) !== embeddedFollowActor) {
    return;
  }

  if (normalizeRemoteActorUri(embeddedFollowObject) !== remoteActorUri) {
    return;
  }

  await input.followUseCases.processVerifiedInboundAccept({
    localActorId: localActor.id,
    remoteActorUri,
    followActivityUri,
    acceptActivityUri,
  });
}

async function handleInboundUndo(
  ctx: InboxContext<undefined>,
  activity: Undo,
  input: {
    canonicalOrigin: string;
    actorRepository: ActivityPubRepository;
    followUseCases: ActivityPubFollowUseCases;
  },
  uri: ReturnType<typeof buildActivityPubUriContract>,
): Promise<void> {
  const undoActivityUri = readRequiredHttpsUrl(activity.id, 'Undo id');
  const remoteActorUri = normalizeRemoteActorUri(
    readRequiredHttpsUrl(activity.actorId, 'Undo actor'),
  );
  const embeddedFollow = await activity.getObject();
  if (!(embeddedFollow instanceof Follow)) {
    return;
  }
  const followActivityUri = readRequiredHttpsUrl(embeddedFollow.id, 'Undo embedded Follow id');
  const embeddedFollowActor = normalizeRemoteActorUri(
    readRequiredHttpsUrl(embeddedFollow.actorId, 'Undo embedded Follow actor'),
  );
  const localActorUri = readRequiredHttpsUrl(
    embeddedFollow.objectId,
    'Undo embedded Follow object',
  );

  if (!(await assertVerifiedActor(ctx, remoteActorUri))) {
    return;
  }

  if (embeddedFollowActor !== remoteActorUri) {
    return;
  }

  const localActor = await resolveLocalActor(input.actorRepository, {
    recipient: ctx.recipient,
    objectUrl: localActorUri,
  });
  if (!localActor || uri.actorUrl(localActor.preferredUsername) !== localActorUri) {
    return;
  }

  const remote = await input.followUseCases.resolveRemoteActor(remoteActorUri);
  if (normalizeRemoteActorUri(remote.actorUri) !== remoteActorUri) {
    return;
  }
  await input.followUseCases.processVerifiedInboundUndo({
    localActorId: localActor.id,
    localActorPreferredUsername: localActor.preferredUsername,
    localActorKeyId: uri.actorKeyId(localActor.preferredUsername),
    localActorUri,
    remoteActorUri: remote.actorUri,
    remoteInboxUri: remote.inboxUri,
    remoteSharedInboxUri: remote.sharedInboxUri,
    undoActivityUri,
    embeddedFollowActivityUri: followActivityUri,
  });
}

/**
 * Validates HTTP signature actor ownership when a test harness supplies `getSignedKeyOwner`.
 *
 * Fedify ingress verifies HTTP signatures and `doesActorOwnKey(activity, httpSigKey, ctx)` before
 * enqueue. Production `Federation.processQueuedTask` uses an `InboxContext` that does not expose
 * `getSignedKeyOwner` in Fedify 2.3.4, so queued delivery trusts that upstream verification.
 */
async function assertVerifiedActor(
  ctx: InboxContext<undefined>,
  expectedActorUri: string,
): Promise<boolean> {
  const getSignedKeyOwner = readOptionalSignedKeyOwner(ctx);
  if (!getSignedKeyOwner) {
    return true;
  }
  const signedOwner = await getSignedKeyOwner();
  if (!signedOwner?.id) {
    return false;
  }
  return normalizeRemoteActorUri(signedOwner.id.href) === normalizeRemoteActorUri(expectedActorUri);
}

function readOptionalSignedKeyOwner(
  ctx: InboxContext<undefined>,
): InboxContextWithSignedKeyOwner['getSignedKeyOwner'] | undefined {
  const candidate = ctx as Partial<InboxContextWithSignedKeyOwner>;
  if (typeof candidate.getSignedKeyOwner === 'function') {
    return candidate.getSignedKeyOwner.bind(
      candidate,
    ) as InboxContextWithSignedKeyOwner['getSignedKeyOwner'];
  }
  return undefined;
}

async function resolveLocalActor(
  actorRepository: ActivityPubRepository,
  input: { recipient?: string | null; objectUrl?: string },
): Promise<ActivityPubActor | undefined> {
  if (input.recipient) {
    return actorRepository.findRemotelyVisibleActorByUsername(input.recipient);
  }
  if (input.objectUrl) {
    const match = input.objectUrl.match(/\/activitypub\/actors\/([^/]+)$/);
    if (!match?.[1]) {
      return undefined;
    }
    return actorRepository.findRemotelyVisibleActorByUsername(decodeURIComponent(match[1]));
  }
  return undefined;
}

function readRequiredHttpsUrl(value: URL | null | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is required`);
  }
  const href = value.href;
  const parsed = new URL(href);
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS`);
  }
  return parsed.toString();
}

/** Test-only inbox context factory for verified listener contract tests. */
export function createVerifiedInboxContextForTest(input: {
  recipient?: string | null;
  signedActorUri: string;
}): InboxContext<undefined> {
  assertActivityPubListenerHarnessRuntime();
  const signedActorUri = normalizeRemoteActorUri(input.signedActorUri);
  return {
    recipient: input.recipient ?? null,
    getSignedKeyOwner: async () => ({ id: new URL(signedActorUri) }),
  } as unknown as InboxContext<undefined>;
}

/** Test-only entrypoint for verified inbound Follow listener handling. */
export async function invokeVerifiedInboundFollowListenerForTest(input: {
  canonicalOrigin: string;
  actorRepository: ActivityPubRepository;
  followUseCases: ActivityPubFollowUseCases;
  ctx: InboxContext<undefined>;
  activity: Follow;
}): Promise<void> {
  assertActivityPubListenerHarnessRuntime();
  const uri = buildActivityPubUriContract(input.canonicalOrigin);
  await handleInboundFollow(input.ctx, input.activity, input, uri);
}

/** Test-only entrypoint for verified inbound Accept listener handling. */
export async function invokeVerifiedInboundAcceptListenerForTest(input: {
  canonicalOrigin: string;
  actorRepository: ActivityPubRepository;
  followUseCases: ActivityPubFollowUseCases;
  ctx: InboxContext<undefined>;
  activity: Accept;
}): Promise<void> {
  assertActivityPubListenerHarnessRuntime();
  const uri = buildActivityPubUriContract(input.canonicalOrigin);
  await handleInboundAccept(input.ctx, input.activity, input, uri);
}

/** Test-only entrypoint for verified inbound Undo listener handling. */
export async function invokeVerifiedInboundUndoListenerForTest(input: {
  canonicalOrigin: string;
  actorRepository: ActivityPubRepository;
  followUseCases: ActivityPubFollowUseCases;
  ctx: InboxContext<undefined>;
  activity: Undo;
}): Promise<void> {
  assertActivityPubListenerHarnessRuntime();
  const uri = buildActivityPubUriContract(input.canonicalOrigin);
  await handleInboundUndo(input.ctx, input.activity, input, uri);
}
