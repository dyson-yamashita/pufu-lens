import { Accept, Follow, Undo } from '@fedify/vocab';
import type { ActivityPubRepository } from './actor-repository.ts';
import {
  createVerifiedInboxContextForTest,
  invokeVerifiedInboundAcceptListenerForTest,
  invokeVerifiedInboundFollowListenerForTest,
  invokeVerifiedInboundUndoListenerForTest,
} from './federation-follow-listeners.ts';
import type { ActivityPubFollowUseCases } from './follow-use-cases.ts';
import type { StoredInboxMessage } from './queue.ts';
import {
  assertActivityPubDbTestRuntime,
  assertActivityPubListenerHarnessRuntime,
} from './test-runtime-guard.ts';

/** Builds a Follow vocabulary object from a pinned ActivityStreams JSON payload. */
export function buildFollowActivityFromJson(activity: unknown): Follow {
  const record = readActivityRecord(activity);
  return new Follow({
    id: new URL(readStringField(record, 'id')),
    actor: new URL(readStringField(record, 'actor')),
    object: new URL(readStringField(record, 'object')),
  });
}

/** Builds an Accept vocabulary object with embedded Follow from ActivityStreams JSON. */
export async function buildAcceptActivityFromJson(activity: unknown): Promise<Accept> {
  const record = readActivityRecord(activity);
  const object = record.object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw new Error('Accept activity missing embedded Follow object');
  }
  const embeddedFollow = buildFollowActivityFromJson(object);
  return new Accept({
    id: new URL(readStringField(record, 'id')),
    actor: new URL(readStringField(record, 'actor')),
    object: embeddedFollow,
  });
}

/** Builds an Undo vocabulary object with embedded Follow from ActivityStreams JSON. */
export async function buildUndoActivityFromJson(activity: unknown): Promise<Undo> {
  const record = readActivityRecord(activity);
  const object = record.object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    throw new Error('Undo activity missing embedded Follow object');
  }
  const embeddedFollow = buildFollowActivityFromJson(object);
  return new Undo({
    id: new URL(readStringField(record, 'id')),
    actor: new URL(readStringField(record, 'actor')),
    object: embeddedFollow,
  });
}

/** Extracts the ActivityStreams activity object from a Fedify queue message fixture. */
export function readActivityFromFedifyQueueMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') {
    throw new Error('queue message must be an object');
  }
  const activity = (message as Record<string, unknown>).activity;
  if (!activity) {
    throw new Error('queue message missing activity');
  }
  return activity;
}

/** Thrown when a stored inbox activity type is unsupported by the verified listener harness. */
export class UnsupportedStoredInboxActivityError extends Error {
  constructor(activityType: string) {
    super(`unsupported inbox activity type: ${activityType}`);
    this.name = 'UnsupportedStoredInboxActivityError';
  }
}

/**
 * Processes a stored inbox queue payload through the verified listener path.
 * Used only from ACTIVITYPUB_RUN_DB_TESTS queue processor contract tests.
 */
export async function processStoredInboxViaVerifiedListenerHarness(input: {
  stored: StoredInboxMessage;
  canonicalOrigin: string;
  actorRepository: ActivityPubRepository;
  followUseCases: ActivityPubFollowUseCases;
  signedActorUri: string;
  recipientUsername?: string | null;
}): Promise<void> {
  assertActivityPubDbTestRuntime();
  const ctx = createVerifiedInboxContextForTest({
    recipient: input.recipientUsername ?? input.stored.identifier,
    signedActorUri: input.signedActorUri,
  });
  const activityType = readActivityType(input.stored.activity);
  const listenerInput = {
    canonicalOrigin: input.canonicalOrigin,
    actorRepository: input.actorRepository,
    followUseCases: input.followUseCases,
    ctx,
  };
  switch (activityType) {
    case 'Follow':
      await invokeVerifiedInboundFollowListenerForTest({
        ...listenerInput,
        activity: buildFollowActivityFromJson(input.stored.activity),
      });
      return;
    case 'Accept':
      await invokeVerifiedInboundAcceptListenerForTest({
        ...listenerInput,
        activity: await buildAcceptActivityFromJson(input.stored.activity),
      });
      return;
    case 'Undo':
      await invokeVerifiedInboundUndoListenerForTest({
        ...listenerInput,
        activity: await buildUndoActivityFromJson(input.stored.activity),
      });
      return;
    default:
      throw new UnsupportedStoredInboxActivityError(activityType);
  }
}

/**
 * Delivers an outbox Follow queue message to a peer verified inbound Follow listener.
 * Test-only fixture bridge for hermetic A/B delivery contract tests.
 */
export async function deliverOutboxFollowToVerifiedInboundListener(input: {
  queueMessage: unknown;
  canonicalOrigin: string;
  actorRepository: ActivityPubRepository;
  followUseCases: ActivityPubFollowUseCases;
  signedActorUri: string;
  recipientUsername?: string | null;
}): Promise<void> {
  assertActivityPubListenerHarnessRuntime();
  const activity = buildFollowActivityFromJson(
    readActivityFromFedifyQueueMessage(input.queueMessage),
  );
  const ctx = createVerifiedInboxContextForTest({
    recipient: input.recipientUsername ?? null,
    signedActorUri: input.signedActorUri,
  });
  await invokeVerifiedInboundFollowListenerForTest({
    canonicalOrigin: input.canonicalOrigin,
    actorRepository: input.actorRepository,
    followUseCases: input.followUseCases,
    ctx,
    activity,
  });
}

/**
 * Delivers an outbox Accept queue message to a peer verified inbound Accept listener.
 * Test-only fixture bridge for hermetic A/B delivery contract tests.
 */
export async function deliverOutboxAcceptToVerifiedInboundListener(input: {
  queueMessage: unknown;
  canonicalOrigin: string;
  actorRepository: ActivityPubRepository;
  followUseCases: ActivityPubFollowUseCases;
  signedActorUri: string;
  recipientUsername?: string | null;
}): Promise<void> {
  assertActivityPubListenerHarnessRuntime();
  const activity = await buildAcceptActivityFromJson(
    readActivityFromFedifyQueueMessage(input.queueMessage),
  );
  const ctx = createVerifiedInboxContextForTest({
    recipient: input.recipientUsername ?? null,
    signedActorUri: input.signedActorUri,
  });
  await invokeVerifiedInboundAcceptListenerForTest({
    canonicalOrigin: input.canonicalOrigin,
    actorRepository: input.actorRepository,
    followUseCases: input.followUseCases,
    ctx,
    activity,
  });
}

/**
 * Delivers an outbox Undo queue message to a peer verified inbound Undo listener.
 * Test-only fixture bridge for hermetic A/B delivery contract tests.
 */
export async function deliverOutboxUndoToVerifiedInboundListener(input: {
  queueMessage: unknown;
  canonicalOrigin: string;
  actorRepository: ActivityPubRepository;
  followUseCases: ActivityPubFollowUseCases;
  signedActorUri: string;
  recipientUsername?: string | null;
}): Promise<void> {
  assertActivityPubListenerHarnessRuntime();
  const activity = await buildUndoActivityFromJson(
    readActivityFromFedifyQueueMessage(input.queueMessage),
  );
  const ctx = createVerifiedInboxContextForTest({
    recipient: input.recipientUsername ?? null,
    signedActorUri: input.signedActorUri,
  });
  await invokeVerifiedInboundUndoListenerForTest({
    canonicalOrigin: input.canonicalOrigin,
    actorRepository: input.actorRepository,
    followUseCases: input.followUseCases,
    ctx,
    activity,
  });
}

function readActivityRecord(activity: unknown): Record<string, unknown> {
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
    throw new Error('activity must be an object');
  }
  return activity as Record<string, unknown>;
}

function readStringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`activity missing ${field}`);
  }
  return value;
}

function readActivityType(activity: unknown): string {
  const record = readActivityRecord(activity);
  const type = record.type;
  if (typeof type !== 'string' || type.length === 0) {
    throw new UnsupportedStoredInboxActivityError('missing');
  }
  return type;
}
