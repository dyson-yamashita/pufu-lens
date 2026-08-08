import { randomUUID } from 'node:crypto';
import type { MessageQueue } from '@fedify/fedify';
import { exportJwk } from '@fedify/fedify';
import type { ActivityPubRepository } from './actor-repository.ts';
import type { FollowTransitionResult } from './follow-model.ts';
import type { PostgresQueueEnqueueOptions } from './queue.ts';

const ACTIVITY_TYPE_IRIS: Record<string, string> = {
  Follow: 'https://www.w3.org/ns/activitystreams#Follow',
  Accept: 'https://www.w3.org/ns/activitystreams#Accept',
  Undo: 'https://www.w3.org/ns/activitystreams#Undo',
};

type OutboxQueue = MessageQueue & {
  enqueue(message: unknown, options?: PostgresQueueEnqueueOptions): Promise<void>;
};

/** Enqueues a follow transition outbox payload through the PostgreSQL Fedify queue adapter. */
export async function enqueueFollowTransitionOutbox(input: {
  canonicalOrigin: string;
  actorRepository: ActivityPubRepository;
  queue: OutboxQueue;
  outboxEnqueue: NonNullable<FollowTransitionResult['outboxEnqueue']>;
}): Promise<void> {
  const actor = await input.actorRepository.findRemotelyVisibleActorByUsername(
    input.outboxEnqueue.localActorPreferredUsername,
  );
  if (!actor) {
    throw new Error('local ActivityPub actor not found for outbox enqueue');
  }
  const keyPair = await input.actorRepository.importActorCryptoKeyPair(actor.id);
  const privateJwk = await exportJwk(keyPair.privateKey);
  const activityType =
    ACTIVITY_TYPE_IRIS[input.outboxEnqueue.activityType] ?? input.outboxEnqueue.activityType;
  const message = {
    type: 'outbox',
    id: randomUUID(),
    baseUrl: input.canonicalOrigin,
    keys: [{ keyId: input.outboxEnqueue.actorKeyId, privateKey: privateJwk }],
    activity: input.outboxEnqueue.activityJsonLd,
    activityId: input.outboxEnqueue.activityUri,
    activityType,
    inbox: input.outboxEnqueue.recipientInbox,
    sharedInbox: input.outboxEnqueue.sharedInbox,
    actorIds: [
      `${input.canonicalOrigin}/activitypub/actors/${encodeURIComponent(
        input.outboxEnqueue.localActorPreferredUsername,
      )}`,
    ],
    started: new Date().toISOString(),
    attempt: 0,
    headers: {},
    orderingKey: input.outboxEnqueue.orderingKey,
    traceContext: {},
  };
  await input.queue.enqueue(message, { orderingKey: input.outboxEnqueue.orderingKey });
}
