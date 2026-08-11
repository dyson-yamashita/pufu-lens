import { randomUUID } from 'node:crypto';
import {
  buildDeterministicAcceptActivityUri,
  buildDeterministicUndoActivityUri,
  buildOutboundFollowActivityUri,
  decodeFollowCollectionCursor,
  encodeFollowCollectionCursor,
  type FollowTransitionResult,
  getFollowCollectionPageSize,
  normalizeRemoteActorUri,
} from './follow-model.ts';
import type {
  AcceptedFollowPage,
  ActivityPubFollowRepository,
  CountAcceptedFollowsInput,
  ListAcceptedFollowsInput,
  ListProjectOutboundFollowsInput,
} from './follow-repository.ts';
import type { ActivityPubFollow, ActivityPubFollowDirection } from './schema.ts';

type FollowKey = `${ActivityPubFollowDirection}:${string}:${string}`;

/**
 * In-memory ActivityPub follow repository for contract and fixture tests.
 * Mirrors PostgreSQL transition semantics without external I/O.
 */
export function createInMemoryActivityPubFollowRepository(): ActivityPubFollowRepository & {
  seedFollow(follow: ActivityPubFollow): void;
  seedActorProject(actorId: string, projectId: string): void;
  listActivityReceipts(): readonly string[];
} {
  const follows = new Map<string, ActivityPubFollow>();
  const followKeys = new Map<FollowKey, string>();
  const activityReceipts = new Set<string>();
  const actorProjects = new Map<string, string>();

  const followKey = (
    direction: ActivityPubFollowDirection,
    localActorId: string,
    remoteActorUri: string,
  ): FollowKey => `${direction}:${localActorId}:${remoteActorUri}`;

  const lockFollow = (
    direction: ActivityPubFollowDirection,
    localActorId: string,
    remoteActorUri: string,
  ): ActivityPubFollow | undefined => {
    const id = followKeys.get(followKey(direction, localActorId, remoteActorUri));
    return id ? follows.get(id) : undefined;
  };

  const insertReceipt = (activityUri: string): boolean => {
    if (activityReceipts.has(activityUri)) {
      return false;
    }
    activityReceipts.add(activityUri);
    return true;
  };

  const storeFollow = (follow: ActivityPubFollow): ActivityPubFollow => {
    follows.set(follow.id, follow);
    followKeys.set(
      followKey(follow.direction, follow.localActorId, follow.remoteActorUri),
      follow.id,
    );
    return follow;
  };

  const captureSnapshot = () => ({
    follows: new Map(follows),
    followKeys: new Map(followKeys),
    activityReceipts: new Set(activityReceipts),
  });

  const restoreSnapshot = (snapshot: ReturnType<typeof captureSnapshot>) => {
    follows.clear();
    for (const [id, follow] of snapshot.follows) {
      follows.set(id, follow);
    }
    followKeys.clear();
    for (const [key, id] of snapshot.followKeys) {
      followKeys.set(key, id);
    }
    activityReceipts.clear();
    for (const receipt of snapshot.activityReceipts) {
      activityReceipts.add(receipt);
    }
  };

  const buildEnqueue = (
    input: Parameters<typeof buildOutboundEnqueueFromRepo>[0],
  ): FollowTransitionResult['outboxEnqueue'] => buildOutboundEnqueueFromRepo(input);

  const repository: ActivityPubFollowRepository & {
    seedFollow(follow: ActivityPubFollow): void;
    seedActorProject(actorId: string, projectId: string): void;
    listActivityReceipts(): readonly string[];
  } = {
    async runInTransaction(callback) {
      const snapshot = captureSnapshot();
      try {
        return await callback(repository);
      } catch (error) {
        restoreSnapshot(snapshot);
        throw error;
      }
    },
    async requestOutboundFollow(input) {
      const normalizedRemote = normalizeRemoteActorUri(input.remoteActorUri);
      const existing = lockFollow('outbound', input.localActorId, normalizedRemote);
      let follow: ActivityPubFollow;
      let followActivityUri: string;
      const now = new Date();

      if (!existing) {
        followActivityUri = buildOutboundFollowActivityUri(input.canonicalOrigin);
        follow = storeFollow({
          id: randomUUID(),
          direction: 'outbound',
          localActorId: input.localActorId,
          remoteActorUri: normalizedRemote,
          remoteInboxUri: input.remoteInboxUri,
          remoteSharedInboxUri: input.remoteSharedInboxUri,
          followActivityUri,
          status: 'pending',
          createdAt: now,
          acceptedAt: null,
          undoneAt: null,
          updatedAt: now,
        });
      } else if (existing.status === 'pending' || existing.status === 'accepted') {
        follow = existing;
        followActivityUri = existing.followActivityUri;
      } else {
        followActivityUri = buildOutboundFollowActivityUri(input.canonicalOrigin);
        follow = storeFollow({
          ...existing,
          followActivityUri,
          remoteInboxUri: input.remoteInboxUri,
          remoteSharedInboxUri: input.remoteSharedInboxUri,
          status: 'pending',
          acceptedAt: null,
          undoneAt: null,
          updatedAt: now,
        });
      }

      if (!insertReceipt(followActivityUri)) {
        return { follow };
      }

      const sharedInbox = Boolean(input.remoteSharedInboxUri);
      return {
        follow,
        outboxEnqueue: buildEnqueue({
          canonicalOrigin: input.canonicalOrigin,
          localActorPreferredUsername: input.localActorPreferredUsername,
          localActorKeyId: input.localActorKeyId,
          activityUri: followActivityUri,
          activityType: 'Follow',
          recipientInbox: sharedInbox
            ? (input.remoteSharedInboxUri as string)
            : input.remoteInboxUri,
          sharedInbox,
          orderingKey: followActivityUri,
          objectUri: normalizedRemote,
        }),
      };
    },
    async recordOutboundAcceptReceipt(input) {
      const normalizedRemote = normalizeRemoteActorUri(input.remoteActorUri);
      const existing = [...follows.values()].find(
        (follow) =>
          follow.direction === 'outbound' &&
          follow.remoteActorUri === normalizedRemote &&
          follow.followActivityUri === input.followActivityUri &&
          (!input.localActorId || follow.localActorId === input.localActorId),
      );
      if (!existing) {
        return null;
      }
      if (!insertReceipt(input.activityUri)) {
        return null;
      }
      if (
        existing.status === 'undone' ||
        existing.status === 'rejected' ||
        existing.status === 'accepted'
      ) {
        return { follow: existing };
      }
      const follow = storeFollow({
        ...existing,
        status: 'accepted',
        acceptedAt: new Date(),
        updatedAt: new Date(),
      });
      return { follow };
    },
    async requestOutboundUndo(input) {
      const normalizedRemote = normalizeRemoteActorUri(input.remoteActorUri);
      const existing = lockFollow('outbound', input.localActorId, normalizedRemote);
      if (!existing) {
        return null;
      }
      if (existing.status === 'rejected') {
        return { follow: existing };
      }
      const undoActivityUri = buildDeterministicUndoActivityUri(
        input.canonicalOrigin,
        existing.followActivityUri,
      );
      let follow = existing;
      if (existing.status === 'pending' || existing.status === 'accepted') {
        follow = storeFollow({
          ...existing,
          status: 'undone',
          acceptedAt: null,
          undoneAt: new Date(),
          updatedAt: new Date(),
        });
      }
      if (!insertReceipt(undoActivityUri)) {
        return { follow };
      }
      const sharedInbox = Boolean(input.remoteSharedInboxUri);
      const actorUri = `${input.canonicalOrigin}/activitypub/actors/${encodeURIComponent(input.localActorPreferredUsername)}`;
      return {
        follow,
        outboxEnqueue: buildEnqueue({
          canonicalOrigin: input.canonicalOrigin,
          localActorPreferredUsername: input.localActorPreferredUsername,
          localActorKeyId: input.localActorKeyId,
          activityUri: undoActivityUri,
          activityType: 'Undo',
          recipientInbox: sharedInbox
            ? (input.remoteSharedInboxUri as string)
            : input.remoteInboxUri,
          sharedInbox,
          orderingKey: existing.followActivityUri,
          objectUri: normalizedRemote,
          embeddedFollowUri: existing.followActivityUri,
          localActorUri: actorUri,
          remoteActorUri: normalizedRemote,
        }),
      };
    },
    async recordInboundFollow(input) {
      if (!insertReceipt(input.followActivityUri)) {
        return null;
      }
      const normalizedRemote = normalizeRemoteActorUri(input.remoteActorUri);
      const existing = lockFollow('inbound', input.localActorId, normalizedRemote);
      if (existing?.status === 'undone' && existing.followActivityUri === input.followActivityUri) {
        return { follow: existing };
      }
      if (
        existing &&
        existing.followActivityUri === input.followActivityUri &&
        existing.status === 'accepted'
      ) {
        return { follow: existing };
      }
      const now = new Date();
      const follow = storeFollow(
        existing
          ? {
              ...existing,
              followActivityUri: input.followActivityUri,
              remoteInboxUri: input.remoteInboxUri,
              remoteSharedInboxUri: input.remoteSharedInboxUri,
              status: 'accepted',
              acceptedAt: now,
              undoneAt: null,
              updatedAt: now,
            }
          : {
              id: randomUUID(),
              direction: 'inbound',
              localActorId: input.localActorId,
              remoteActorUri: normalizedRemote,
              remoteInboxUri: input.remoteInboxUri,
              remoteSharedInboxUri: input.remoteSharedInboxUri,
              followActivityUri: input.followActivityUri,
              status: 'accepted',
              createdAt: now,
              acceptedAt: now,
              undoneAt: null,
              updatedAt: now,
            },
      );
      const acceptActivityUri = buildDeterministicAcceptActivityUri(
        input.canonicalOrigin,
        input.followActivityUri,
      );
      const sharedInbox = Boolean(input.remoteSharedInboxUri);
      const recipientInbox = sharedInbox
        ? (input.remoteSharedInboxUri as string)
        : input.remoteInboxUri;
      return {
        follow,
        outboxEnqueue: buildEnqueue({
          canonicalOrigin: input.canonicalOrigin,
          localActorPreferredUsername: input.localActorPreferredUsername,
          localActorKeyId: input.localActorKeyId,
          activityUri: acceptActivityUri,
          activityType: 'Accept',
          recipientInbox,
          sharedInbox,
          orderingKey: input.followActivityUri,
          objectUri: input.followActivityUri,
          localActorUri: input.localActorUri,
          remoteActorUri: normalizedRemote,
        }),
      };
    },
    async recordInboundUndoFollow(input) {
      if (!insertReceipt(input.undoActivityUri)) {
        return null;
      }
      const normalizedRemote = normalizeRemoteActorUri(input.remoteActorUri);
      const existing = lockFollow('inbound', input.localActorId, normalizedRemote);
      const now = new Date();
      if (
        existing &&
        existing.status === 'accepted' &&
        existing.followActivityUri !== input.embeddedFollowActivityUri
      ) {
        return { follow: existing };
      }
      const follow = storeFollow(
        existing
          ? existing.status === 'undone'
            ? existing
            : {
                ...existing,
                status: 'undone',
                acceptedAt: null,
                undoneAt: now,
                updatedAt: now,
              }
          : {
              id: randomUUID(),
              direction: 'inbound',
              localActorId: input.localActorId,
              remoteActorUri: normalizedRemote,
              remoteInboxUri: input.remoteInboxUri,
              remoteSharedInboxUri: input.remoteSharedInboxUri,
              followActivityUri: input.embeddedFollowActivityUri,
              status: 'undone',
              createdAt: now,
              acceptedAt: null,
              undoneAt: now,
              updatedAt: now,
            },
      );
      return { follow };
    },
    async listAcceptedFollows(input: ListAcceptedFollowsInput): Promise<AcceptedFollowPage> {
      const pageSize = getFollowCollectionPageSize();
      let cursor: ReturnType<typeof decodeFollowCollectionCursor> | undefined;
      if (input.cursor) {
        cursor = decodeFollowCollectionCursor(input.cursor);
      }
      const items = [...follows.values()]
        .filter(
          (follow) =>
            follow.localActorId === input.localActorId &&
            follow.direction === input.direction &&
            follow.status === 'accepted',
        )
        .sort((left, right) => {
          const createdDiff = left.createdAt.getTime() - right.createdAt.getTime();
          if (createdDiff !== 0) {
            return createdDiff;
          }
          return left.id.localeCompare(right.id);
        })
        .filter((follow) => {
          if (!cursor) {
            return true;
          }
          const createdAt = cursor.createdAt;
          return (
            follow.createdAt.toISOString() > createdAt ||
            (follow.createdAt.toISOString() === createdAt && follow.id > cursor.id)
          );
        });
      const hasMore = items.length > pageSize;
      const page = hasMore ? items.slice(0, pageSize) : items;
      const last = page.at(-1);
      return {
        items: page,
        nextCursor:
          hasMore && last
            ? encodeFollowCollectionCursor({ createdAt: last.createdAt, id: last.id })
            : undefined,
      };
    },
    async countAcceptedFollows(input: CountAcceptedFollowsInput): Promise<number> {
      return [...follows.values()].filter(
        (follow) =>
          follow.localActorId === input.localActorId &&
          follow.direction === input.direction &&
          follow.status === 'accepted',
      ).length;
    },
    async listProjectOutboundFollows(input: ListProjectOutboundFollowsInput) {
      return [...follows.values()]
        .filter(
          (follow) =>
            follow.direction === 'outbound' &&
            actorProjects.get(follow.localActorId) === input.projectId,
        )
        .sort((left, right) => {
          const createdDiff = left.createdAt.getTime() - right.createdAt.getTime();
          if (createdDiff !== 0) {
            return createdDiff;
          }
          return left.id.localeCompare(right.id);
        });
    },
    seedFollow(follow: ActivityPubFollow) {
      storeFollow(follow);
    },
    seedActorProject(actorId: string, projectId: string) {
      actorProjects.set(actorId, projectId);
    },
    listActivityReceipts() {
      return [...activityReceipts];
    },
  };

  return repository;
}

function buildOutboundEnqueueFromRepo(input: {
  canonicalOrigin: string;
  localActorPreferredUsername: string;
  localActorKeyId: string;
  activityUri: string;
  activityType: string;
  recipientInbox: string;
  sharedInbox: boolean;
  orderingKey: string;
  objectUri: string;
  embeddedFollowUri?: string;
  localActorUri?: string;
  remoteActorUri?: string;
}): NonNullable<FollowTransitionResult['outboxEnqueue']> {
  const actorUri = `${input.canonicalOrigin}/activitypub/actors/${encodeURIComponent(input.localActorPreferredUsername)}`;
  const activityJsonLd =
    input.activityType === 'Undo'
      ? {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: input.activityUri,
          type: 'Undo',
          actor: actorUri,
          object: {
            id: input.embeddedFollowUri ?? input.objectUri,
            type: 'Follow',
            actor: actorUri,
            object: input.remoteActorUri ?? input.objectUri,
          },
        }
      : input.activityType === 'Accept'
        ? {
            '@context': 'https://www.w3.org/ns/activitystreams',
            id: input.activityUri,
            type: 'Accept',
            actor: actorUri,
            object: {
              id: input.objectUri,
              type: 'Follow',
              actor: input.remoteActorUri ?? input.objectUri,
              object: input.localActorUri ?? actorUri,
            },
          }
        : {
            '@context': 'https://www.w3.org/ns/activitystreams',
            id: input.activityUri,
            type: 'Follow',
            actor: actorUri,
            object: input.objectUri,
          };

  return {
    activityUri: input.activityUri,
    activityType: input.activityType,
    recipientInbox: input.recipientInbox,
    sharedInbox: input.sharedInbox,
    orderingKey: input.orderingKey,
    actorKeyId: input.localActorKeyId,
    localActorPreferredUsername: input.localActorPreferredUsername,
    activityJsonLd,
  };
}
