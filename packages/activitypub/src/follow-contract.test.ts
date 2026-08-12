import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  buildDeterministicAcceptActivityUri,
  buildDeterministicUndoActivityUri,
  buildOutboundFollowActivityUri,
  decodeFollowCollectionCursor,
  encodeFollowCollectionCursor,
  getFollowCollectionPageSize,
  normalizeRemoteActorUri,
} from './follow-model.ts';
import { createInMemoryActivityPubFollowRepository } from './in-memory-follow-repository.ts';

const canonicalOrigin = 'https://lens.test';
const followUri =
  'https://lens.test/activitypub/activities/follow/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const localActorId = '10000000-0000-0000-0000-000000000001';
const localActorUsername = 'sample-project';
const localActorKeyId = `${canonicalOrigin}/activitypub/actors/${localActorUsername}#main-key`;
const localActorUri = `${canonicalOrigin}/activitypub/actors/${localActorUsername}`;
const remoteActorUri = 'https://remote.example/users/alice';
const remoteInboxUri = `${remoteActorUri}/inbox`;
const remoteSharedInboxUri = 'https://remote.example/inbox';

const baseOutboundInput = {
  canonicalOrigin,
  localActorId,
  localActorPreferredUsername: localActorUsername,
  localActorKeyId,
  remoteActorUri,
  remoteInboxUri,
  remoteSharedInboxUri,
};

const baseInboundInput = {
  canonicalOrigin,
  localActorId,
  localActorPreferredUsername: localActorUsername,
  localActorKeyId,
  localActorUri,
  remoteActorUri,
  remoteInboxUri,
  remoteSharedInboxUri,
};

test('normalizeRemoteActorUri normalizes HTTPS actor URLs', () => {
  const normalized = normalizeRemoteActorUri('https://remote.example/users/alice/');
  assert.equal(normalized, 'https://remote.example/users/alice/');
});

test('normalizeRemoteActorUri rejects non-HTTPS URLs', () => {
  assert.throws(() => normalizeRemoteActorUri('http://remote.example/users/alice'));
});

test('buildOutboundFollowActivityUri uses canonical origin and UUID segment', () => {
  const uri = buildOutboundFollowActivityUri(canonicalOrigin);
  assert.match(uri, /^https:\/\/lens\.test\/activitypub\/activities\/follow\/[0-9a-f-]{36}$/);
});

test('deterministic Accept and Undo URIs are stable for the same Follow URI', () => {
  const acceptA = buildDeterministicAcceptActivityUri(canonicalOrigin, followUri);
  const acceptB = buildDeterministicAcceptActivityUri(canonicalOrigin, followUri);
  const undoA = buildDeterministicUndoActivityUri(canonicalOrigin, followUri);
  const undoB = buildDeterministicUndoActivityUri(canonicalOrigin, followUri);
  assert.equal(acceptA, acceptB);
  assert.equal(undoA, undoB);
  assert.notEqual(acceptA, undoA);
  assert.match(acceptA, /^https:\/\/lens\.test\/activitypub\/activities\/accept\/[0-9a-f]{64}$/);
  assert.match(undoA, /^https:\/\/lens\.test\/activitypub\/activities\/undo\/[0-9a-f]{64}$/);
});

test('collection cursor encode/decode round-trips', () => {
  const createdAt = new Date('2026-08-01T00:00:00.000Z');
  const id = 'f0000000-0000-0000-0000-000000000001';
  const cursor = encodeFollowCollectionCursor({ createdAt, id });
  const decoded = decodeFollowCollectionCursor(cursor);
  assert.equal(decoded.id, id);
  assert.equal(decoded.createdAt, createdAt.toISOString());
});

test('decodeFollowCollectionCursor fails closed on invalid cursors', () => {
  assert.throws(() => decodeFollowCollectionCursor(''));
  assert.throws(() => decodeFollowCollectionCursor('not-valid-base64'));
  assert.throws(() =>
    decodeFollowCollectionCursor(
      Buffer.from(JSON.stringify({ version: 99, createdAt: 'x', id: 'y' }), 'utf8').toString(
        'base64url',
      ),
    ),
  );
});

test('getFollowCollectionPageSize returns bounded page size 20', () => {
  assert.equal(getFollowCollectionPageSize(), 20);
});

test('outbound follow transitions: absent to pending with enqueue', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const result = await repository.requestOutboundFollow(baseOutboundInput);
  assert.equal(result.follow.status, 'pending');
  assert.ok(result.outboxEnqueue);
  assert.equal(result.outboxEnqueue?.activityType, 'Follow');
});

test('outbound follow pending/accepted are idempotent for safe re-enqueue', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const first = await repository.requestOutboundFollow(baseOutboundInput);
  const second = await repository.requestOutboundFollow(baseOutboundInput);
  assert.equal(first.follow.id, second.follow.id);
  assert.equal(first.follow.followActivityUri, second.follow.followActivityUri);
  assert.equal(second.outboxEnqueue, undefined);
});

test('outbound follow after undone starts new generation', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const first = await repository.requestOutboundFollow(baseOutboundInput);
  await repository.requestOutboundUndo(baseOutboundInput);
  const second = await repository.requestOutboundFollow(baseOutboundInput);
  assert.notEqual(first.follow.followActivityUri, second.follow.followActivityUri);
  assert.equal(second.follow.status, 'pending');
  assert.ok(second.outboxEnqueue);
});

test('outbound accept receipt accepts pending and ignores stale generation', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const follow = await repository.requestOutboundFollow(baseOutboundInput);
  const accepted = await repository.recordOutboundAcceptReceipt({
    canonicalOrigin,
    localActorId,
    remoteActorUri,
    followActivityUri: follow.follow.followActivityUri,
    activityUri: `${canonicalOrigin}/activitypub/activities/accept/${randomUUID()}`,
  });
  assert.equal(accepted?.follow.status, 'accepted');
  const stale = await repository.recordOutboundAcceptReceipt({
    canonicalOrigin,
    localActorId,
    remoteActorUri,
    followActivityUri: 'https://lens.test/activitypub/activities/follow/stale',
    activityUri: `${canonicalOrigin}/activitypub/activities/accept/${randomUUID()}`,
  });
  assert.equal(stale, null);
});

test('shared inbox Accept resolves the outbound follow without a recipient actor hint', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const follow = await repository.requestOutboundFollow(baseOutboundInput);
  const accepted = await repository.recordOutboundAcceptReceipt({
    canonicalOrigin,
    remoteActorUri,
    followActivityUri: follow.follow.followActivityUri,
    activityUri: `${canonicalOrigin}/activitypub/activities/accept/${randomUUID()}`,
  });
  assert.equal(accepted?.follow.localActorId, localActorId);
  assert.equal(accepted?.follow.status, 'accepted');
});

test('outbound accept after undo does not resurrect', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const follow = await repository.requestOutboundFollow(baseOutboundInput);
  await repository.requestOutboundUndo(baseOutboundInput);
  const accepted = await repository.recordOutboundAcceptReceipt({
    canonicalOrigin,
    localActorId,
    remoteActorUri,
    followActivityUri: follow.follow.followActivityUri,
    activityUri: `${canonicalOrigin}/activitypub/activities/accept/${randomUUID()}`,
  });
  assert.equal(accepted?.follow.status, 'undone');
});

test('outbound undo is idempotent for safe re-enqueue', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  await repository.requestOutboundFollow(baseOutboundInput);
  const first = await repository.requestOutboundUndo(baseOutboundInput);
  const second = await repository.requestOutboundUndo(baseOutboundInput);
  assert.equal(first?.follow.status, 'undone');
  assert.equal(second?.outboxEnqueue, undefined);
});

test('inbound follow accepts and enqueues Accept', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/inbound-1`;
  const result = await repository.recordInboundFollow({
    ...baseInboundInput,
    followActivityUri,
  });
  assert.equal(result?.follow.status, 'accepted');
  assert.equal(result?.outboxEnqueue?.activityType, 'Accept');
});

test('inbound follow duplicate activity id is a no-op', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/inbound-dup`;
  await repository.recordInboundFollow({ ...baseInboundInput, followActivityUri });
  const duplicate = await repository.recordInboundFollow({
    ...baseInboundInput,
    followActivityUri,
  });
  assert.equal(duplicate, null);
});

test('inbound undo before follow creates tombstone for same follow activity id', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/reordered`;
  const undo = await repository.recordInboundUndoFollow({
    ...baseInboundInput,
    undoActivityUri: `${canonicalOrigin}/activitypub/activities/undo/reordered`,
    embeddedFollowActivityUri: followActivityUri,
  });
  assert.equal(undo?.follow.status, 'undone');
  const follow = await repository.recordInboundFollow({ ...baseInboundInput, followActivityUri });
  assert.equal(follow?.follow.status, 'undone');
  assert.equal(follow?.outboxEnqueue, undefined);
});

test('inbound follow after undo accepts new generation with different follow activity id', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const staleFollowUri = `${canonicalOrigin}/activitypub/activities/follow/reordered-stale`;
  await repository.recordInboundUndoFollow({
    ...baseInboundInput,
    undoActivityUri: `${canonicalOrigin}/activitypub/activities/undo/reordered-stale`,
    embeddedFollowActivityUri: staleFollowUri,
  });
  const newFollowUri = `${canonicalOrigin}/activitypub/activities/follow/reordered-new`;
  const refollow = await repository.recordInboundFollow({
    ...baseInboundInput,
    followActivityUri: newFollowUri,
  });
  assert.equal(refollow?.follow.status, 'accepted');
  assert.equal(refollow?.outboxEnqueue?.activityType, 'Accept');
});

test('inbound follow Accept outbox uses deterministic accept activity URI as ordering key', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/inbound-ordering`;
  const result = await repository.recordInboundFollow({
    ...baseInboundInput,
    followActivityUri,
  });
  const acceptActivityUri = buildDeterministicAcceptActivityUri(canonicalOrigin, followActivityUri);
  assert.equal(result?.outboxEnqueue?.orderingKey, acceptActivityUri);
  assert.notEqual(result?.outboxEnqueue?.orderingKey, followActivityUri);
});

test('Accept outbox JSON embeds remote actor on Follow object', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/accept-json`;
  const result = await repository.recordInboundFollow({
    ...baseInboundInput,
    followActivityUri,
  });
  const jsonLd = result?.outboxEnqueue?.activityJsonLd as {
    type: string;
    actor: string;
    object: { type: string; actor: string; object: string; id: string };
  };
  assert.equal(jsonLd.type, 'Accept');
  assert.equal(jsonLd.actor, localActorUri);
  assert.equal(jsonLd.object.type, 'Follow');
  assert.equal(jsonLd.object.id, followActivityUri);
  assert.equal(jsonLd.object.actor, remoteActorUri);
  assert.equal(jsonLd.object.object, localActorUri);
});

test('Accept outbox uses shared inbox recipient when remote actor provides sharedInbox', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/accept-shared`;
  const result = await repository.recordInboundFollow({
    ...baseInboundInput,
    followActivityUri,
    remoteSharedInboxUri: remoteSharedInboxUri,
  });
  assert.equal(result?.outboxEnqueue?.sharedInbox, true);
  assert.equal(result?.outboxEnqueue?.recipientInbox, remoteSharedInboxUri);
});

test('Accept outbox uses personal inbox when remote actor has no sharedInbox', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/accept-personal`;
  const result = await repository.recordInboundFollow({
    ...baseInboundInput,
    followActivityUri,
    remoteSharedInboxUri: null,
  });
  assert.equal(result?.outboxEnqueue?.sharedInbox, false);
  assert.equal(result?.outboxEnqueue?.recipientInbox, remoteInboxUri);
});

test('outbound Undo outbox JSON embeds local actor and remote object on Follow', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const follow = await repository.requestOutboundFollow({
    ...baseOutboundInput,
    remoteSharedInboxUri: null,
  });
  const accepted = await repository.recordOutboundAcceptReceipt({
    canonicalOrigin,
    localActorId,
    remoteActorUri,
    followActivityUri: follow.follow.followActivityUri,
    activityUri: `${canonicalOrigin}/activitypub/activities/accept/undo-json`,
  });
  assert.ok(accepted);
  const undo = await repository.requestOutboundUndo({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: localActorUsername,
    localActorKeyId,
    remoteActorUri,
    remoteInboxUri,
    remoteSharedInboxUri: null,
  });
  const jsonLd = undo?.outboxEnqueue?.activityJsonLd as {
    type: string;
    actor: string;
    object: { type: string; actor: string; object: string; id: string };
  };
  assert.equal(jsonLd.type, 'Undo');
  assert.equal(jsonLd.actor, localActorUri);
  assert.equal(jsonLd.object.type, 'Follow');
  assert.equal(jsonLd.object.id, follow.follow.followActivityUri);
  assert.equal(jsonLd.object.actor, localActorUri);
  assert.equal(jsonLd.object.object, remoteActorUri);
});

test('stale inbound Undo does not undo new generation re-follow', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const staleFollowUri = `${canonicalOrigin}/activitypub/activities/follow/stale-undo`;
  const newFollowUri = `${canonicalOrigin}/activitypub/activities/follow/new-after-stale-undo`;
  await repository.recordInboundUndoFollow({
    ...baseInboundInput,
    undoActivityUri: `${canonicalOrigin}/activitypub/activities/undo/stale-before`,
    embeddedFollowActivityUri: staleFollowUri,
  });
  const refollow = await repository.recordInboundFollow({
    ...baseInboundInput,
    followActivityUri: newFollowUri,
  });
  assert.equal(refollow?.follow.status, 'accepted');
  const staleUndo = await repository.recordInboundUndoFollow({
    ...baseInboundInput,
    undoActivityUri: `${canonicalOrigin}/activitypub/activities/undo/stale-after-refollow`,
    embeddedFollowActivityUri: staleFollowUri,
  });
  assert.equal(staleUndo?.follow.status, 'accepted');
  assert.equal(staleUndo?.follow.followActivityUri, newFollowUri);
  const duplicateStaleUndo = await repository.recordInboundUndoFollow({
    ...baseInboundInput,
    undoActivityUri: `${canonicalOrigin}/activitypub/activities/undo/stale-after-refollow-dup`,
    embeddedFollowActivityUri: staleFollowUri,
  });
  assert.equal(duplicateStaleUndo?.follow.status, 'accepted');
  assert.equal(duplicateStaleUndo?.follow.followActivityUri, newFollowUri);
});

test('accepted follow collection pagination walks opaque cursor beyond page size', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const pageSize = getFollowCollectionPageSize();
  const now = new Date('2026-08-01T00:00:00.000Z');
  for (let index = 0; index < pageSize + 5; index += 1) {
    repository.seedFollow({
      id: `f1000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      direction: 'inbound',
      localActorId,
      remoteActorUri: `https://remote.example/users/page-${index}`,
      remoteInboxUri: 'https://remote.example/inbox',
      remoteSharedInboxUri: null,
      followActivityUri: `https://remote.example/activities/follow-page-${index}`,
      status: 'accepted',
      createdAt: new Date(now.getTime() + index * 1000),
      acceptedAt: new Date(now.getTime() + index * 1000),
      undoneAt: null,
      updatedAt: new Date(now.getTime() + index * 1000),
    });
  }
  const firstPage = await repository.listAcceptedFollows({
    localActorId,
    direction: 'inbound',
  });
  assert.equal(firstPage.items.length, pageSize);
  assert.ok(firstPage.nextCursor);
  const secondPage = await repository.listAcceptedFollows({
    localActorId,
    direction: 'inbound',
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.items.length, 5);
  assert.equal(secondPage.nextCursor, undefined);
  const total = await repository.countAcceptedFollows({ localActorId, direction: 'inbound' });
  assert.equal(total, pageSize + 5);
  for (const follow of [...firstPage.items, ...secondPage.items]) {
    assert.match(follow.remoteActorUri, /^https:\/\/remote\.example\/users\/page-\d+$/);
    assert.equal(follow.status, 'accepted');
  }
});

test('accepted follow collection pagination uses opaque cursor', async () => {
  const repository = createInMemoryActivityPubFollowRepository();
  const now = new Date('2026-08-01T00:00:00.000Z');
  for (let index = 0; index < 3; index += 1) {
    repository.seedFollow({
      id: `f0000000-0000-0000-0000-00000000000${index + 1}`,
      direction: 'inbound',
      localActorId,
      remoteActorUri: `https://remote.example/users/follower-${index}`,
      remoteInboxUri: 'https://remote.example/inbox',
      remoteSharedInboxUri: null,
      followActivityUri: `https://remote.example/activities/follow-${index}`,
      status: 'accepted',
      createdAt: new Date(now.getTime() + index * 1000),
      acceptedAt: new Date(now.getTime() + index * 1000),
      undoneAt: null,
      updatedAt: new Date(now.getTime() + index * 1000),
    });
  }
  const page = await repository.listAcceptedFollows({
    localActorId,
    direction: 'inbound',
  });
  assert.equal(page.items.length, 3);
  assert.equal(await repository.countAcceptedFollows({ localActorId, direction: 'inbound' }), 3);
});

/**
 * Hermetic Pufu Lens A/B mutual-follow fixture.
 * Instance A follows B, B accepts; then B follows A for mutual relationship.
 */
test('pufu lens A/B mutual follow fixture is independent and idempotent', async () => {
  const actorA = '10000000-0000-0000-0000-00000000000a';
  const actorB = '10000000-0000-0000-0000-00000000000b';
  const repoA = createInMemoryActivityPubFollowRepository();
  const repoB = createInMemoryActivityPubFollowRepository();
  const remoteA = `${canonicalOrigin}/activitypub/actors/project-a`;
  const remoteB = `${canonicalOrigin}/activitypub/actors/project-b`;

  const aFollowsB = await repoA.requestOutboundFollow({
    ...baseOutboundInput,
    localActorId: actorA,
    localActorPreferredUsername: 'project-a',
    remoteActorUri: remoteB,
    remoteInboxUri: `${remoteB}/inbox`,
    remoteSharedInboxUri: null,
  });
  const bAcceptsA = await repoB.recordInboundFollow({
    ...baseInboundInput,
    localActorId: actorB,
    localActorPreferredUsername: 'project-b',
    localActorUri: remoteB,
    remoteActorUri: remoteA,
    remoteInboxUri: `${remoteA}/inbox`,
    remoteSharedInboxUri: null,
    followActivityUri: aFollowsB.follow.followActivityUri,
  });
  assert.equal(bAcceptsA?.follow.status, 'accepted');

  const bFollowsA = await repoB.requestOutboundFollow({
    ...baseOutboundInput,
    localActorId: actorB,
    localActorPreferredUsername: 'project-b',
    remoteActorUri: remoteA,
    remoteInboxUri: `${remoteA}/inbox`,
    remoteSharedInboxUri: null,
  });
  const aAcceptsB = await repoA.recordInboundFollow({
    ...baseInboundInput,
    localActorId: actorA,
    localActorPreferredUsername: 'project-a',
    localActorUri: remoteA,
    remoteActorUri: remoteB,
    remoteInboxUri: `${remoteB}/inbox`,
    remoteSharedInboxUri: null,
    followActivityUri: bFollowsA.follow.followActivityUri,
  });
  assert.equal(aAcceptsB?.follow.status, 'accepted');

  const repeat = await repoA.requestOutboundFollow({
    ...baseOutboundInput,
    localActorId: actorA,
    localActorPreferredUsername: 'project-a',
    remoteActorUri: remoteB,
    remoteInboxUri: `${remoteB}/inbox`,
    remoteSharedInboxUri: null,
  });
  assert.equal(repeat.outboxEnqueue, undefined);
});

/**
 * Mastodon-compatible fixture contract (local/deterministic; no real Mastodon):
 * - WebFinger rel=self application/activity+json
 * - Actor Service with inbox + optional sharedInbox
 * - Follow/Accept/Undo activity shapes with HTTPS ids
 */
test('mastodon-compatible fixture follows project actor and aggregate actor locally', async () => {
  const mastodonActor = 'https://mastodon.fixture.example/users/alice';
  const mastodonInbox = `${mastodonActor}/inbox`;
  const projectActorId = '20000000-0000-0000-0000-000000000001';
  const aggregateActorId = '20000000-0000-0000-0000-000000000002';
  const projectActorUri = `${canonicalOrigin}/activitypub/actors/sample-project`;
  const aggregateActorUri = `${canonicalOrigin}/activitypub/actors/all`;
  const repository = createInMemoryActivityPubFollowRepository();

  for (const [localActorId, localActorUri, preferredUsername] of [
    [projectActorId, projectActorUri, 'sample-project'],
    [aggregateActorId, aggregateActorUri, 'all'],
  ] as const) {
    const followActivityUri = `${mastodonActor}/activities/follow-${preferredUsername}`;
    const inbound = await repository.recordInboundFollow({
      canonicalOrigin,
      localActorId,
      localActorPreferredUsername: preferredUsername,
      localActorKeyId: `${localActorUri}#main-key`,
      localActorUri,
      remoteActorUri: mastodonActor,
      remoteInboxUri: mastodonInbox,
      remoteSharedInboxUri: null,
      followActivityUri,
    });
    assert.equal(inbound?.outboxEnqueue?.activityType, 'Accept');
    const undo = await repository.recordInboundUndoFollow({
      canonicalOrigin,
      localActorId,
      localActorPreferredUsername: preferredUsername,
      localActorKeyId: `${localActorUri}#main-key`,
      localActorUri,
      remoteActorUri: mastodonActor,
      remoteInboxUri: mastodonInbox,
      remoteSharedInboxUri: null,
      undoActivityUri: `${mastodonActor}/activities/undo-${preferredUsername}`,
      embeddedFollowActivityUri: followActivityUri,
    });
    assert.equal(undo?.follow.status, 'undone');
  }
});
