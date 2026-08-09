import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  createPostgresActivityPubFollowRepository,
  createPostgresActivityPubFollowTransactionRepository,
} from './follow-repository.ts';
import { createActivityPubFollowUseCases } from './follow-use-cases.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!runDbTests) {
  console.log('Skipping follow repository DB tests (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for follow repository DB tests.');
}

const resolvedDatabaseUrl: string = databaseUrl;
const canonicalOrigin = 'https://lens.test';
const fixtureProjectId = '4f000000-0000-0000-0000-00000000db11';
const fixtureProjectSlug = 'activitypub-follow-db-fixture';
const secondaryProjectId = '4f000000-0000-0000-0000-00000000db12';
const localActorId = '4f000000-0000-0000-0000-00000000db13';
const remoteActorUri = 'https://remote.example/users/alice';
const remoteInboxUri = `${remoteActorUri}/inbox`;

await main();

async function main() {
  const sql = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    await cleanupFixture(sql);
    await assertOutboundFollowAcceptUndoTransitions(sql);
    await assertInboundFollowAcceptAndUndoBeforeFollowTombstone(sql);
    await assertDuplicateAndReorderedReceipts(sql);
    await assertInboundRefollowAfterUndoWithNewGeneration(sql);
    await assertEnqueueFailureRollsBackFollowState(sql);
    await assertInboundAcceptEnqueueFailureRollsBackFollowState(sql);
    await assertConcurrentOutboundFollowIsIdempotent(sql);
    await assertAcceptedOutboundUndoPreservesAcceptedAt(sql);
    await assertStaleInboundUndoDoesNotCancelNewGeneration(sql);
    await assertMigration0017TimestampConstraints(sql);
    await assertProjectScopedOutboundListing(sql);
    await assertTransactionRollback(sql);
    console.log('activitypub follow repository DB tests passed');
  } finally {
    await cleanupFixture(sql);
    await sql.end({ timeout: 5 });
  }
}

async function cleanupFixture(sql: postgres.Sql) {
  await sql`DELETE FROM public.activitypub_follows WHERE local_actor_id = ${localActorId}::uuid`;
  await sql`DELETE FROM public.activitypub_activities WHERE local_actor_id = ${localActorId}::uuid`;
  await sql`DELETE FROM public.activitypub_actors WHERE id = ${localActorId}::uuid`;
  await sql`DELETE FROM public.projects WHERE id IN (${fixtureProjectId}::uuid, ${secondaryProjectId}::uuid)`;
}

async function seedFixture(sql: postgres.Sql) {
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${fixtureProjectId}::uuid,
      ${fixtureProjectSlug},
      'Follow DB Fixture',
      'graph_activitypub_follow_db_fixture',
      ${fixtureProjectSlug},
      'public'
    )
  `;
  await sql`
    INSERT INTO public.activitypub_actors (
      id,
      project_id,
      kind,
      preferred_username,
      display_name,
      enabled,
      public_key_pem,
      encrypted_private_key,
      created_at,
      updated_at
    )
    VALUES (
      ${localActorId}::uuid,
      ${fixtureProjectId}::uuid,
      'project',
      ${fixtureProjectSlug},
      'Follow DB Fixture',
      true,
      '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2\n4vl4Z2TLpqbb5CHmpSMgAS5KdEcTRL+RscJ0dHqN0NvdWT7qfB8xtB2LBvOkvUs\n7Y8YkPeDlaPk9N6pRSZ0WQgWwgQnR5UwP09NuoGfeDmGg8A32gs2WnLvvHQgkPw\nIDAQAB\n-----END PUBLIC KEY-----',
      '{"version":1,"algorithm":"aes-256-gcm","iv":"aXY=","ciphertext":"YQ==","tag":"dGFn"}'::jsonb,
      now(),
      now()
    )
  `;
}

async function assertOutboundFollowAcceptUndoTransitions(sql: postgres.Sql) {
  await seedFixture(sql);
  const repository = createPostgresActivityPubFollowRepository({ sql });
  const follow = await repository.requestOutboundFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    remoteActorUri,
    remoteInboxUri,
    remoteSharedInboxUri: null,
  });
  assert.equal(follow.follow.status, 'pending');
  assert.equal(follow.outboxEnqueue?.activityType, 'Follow');

  const accepted = await repository.recordOutboundAcceptReceipt({
    canonicalOrigin,
    localActorId,
    remoteActorUri,
    followActivityUri: follow.follow.followActivityUri,
    activityUri: `${canonicalOrigin}/activitypub/activities/accept/db-1`,
  });
  assert.ok(accepted);
  assert.equal(accepted?.follow.status, 'accepted');

  const undone = await repository.requestOutboundUndo({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    remoteActorUri,
    remoteInboxUri,
    remoteSharedInboxUri: null,
  });
  assert.ok(undone?.outboxEnqueue?.activityType === 'Undo');
  assert.equal(undone?.follow.status, 'undone');
}

async function assertInboundFollowAcceptAndUndoBeforeFollowTombstone(sql: postgres.Sql) {
  await cleanupFixture(sql);
  await seedFixture(sql);
  const repository = createPostgresActivityPubFollowRepository({ sql });
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/inbound-db-1`;
  const undo = await repository.recordInboundUndoFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
    remoteActorUri,
    remoteInboxUri,
    remoteSharedInboxUri: null,
    undoActivityUri: `${remoteActorUri}/activities/undo-db-1`,
    embeddedFollowActivityUri: followActivityUri,
  });
  assert.equal(undo?.follow.status, 'undone');

  const staleFollow = await repository.recordInboundFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
    remoteActorUri,
    remoteInboxUri,
    remoteSharedInboxUri: null,
    followActivityUri,
  });
  assert.equal(staleFollow?.outboxEnqueue, undefined);
  assert.equal(staleFollow?.follow.status, 'undone');
}

async function assertDuplicateAndReorderedReceipts(sql: postgres.Sql) {
  const repository = createPostgresActivityPubFollowRepository({ sql });
  const duplicateRemote = 'https://remote.example/users/alice-dup';
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/inbound-db-dup`;
  const first = await repository.recordInboundFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
    remoteActorUri: duplicateRemote,
    remoteInboxUri: `${duplicateRemote}/inbox`,
    remoteSharedInboxUri: null,
    followActivityUri,
  });
  assert.ok(first?.outboxEnqueue);
  const duplicate = await repository.recordInboundFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
    remoteActorUri: duplicateRemote,
    remoteInboxUri: `${duplicateRemote}/inbox`,
    remoteSharedInboxUri: null,
    followActivityUri,
  });
  assert.equal(duplicate, null);
}

async function assertInboundRefollowAfterUndoWithNewGeneration(sql: postgres.Sql) {
  const repository = createPostgresActivityPubFollowRepository({ sql });
  const duplicateRemote = 'https://remote.example/users/refollow';
  const staleFollowUri = `${canonicalOrigin}/activitypub/activities/follow/refollow-stale`;
  await repository.recordInboundUndoFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
    remoteActorUri: duplicateRemote,
    remoteInboxUri: `${duplicateRemote}/inbox`,
    remoteSharedInboxUri: null,
    undoActivityUri: `${duplicateRemote}/activities/undo-refollow`,
    embeddedFollowActivityUri: staleFollowUri,
  });
  const stale = await repository.recordInboundFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
    remoteActorUri: duplicateRemote,
    remoteInboxUri: `${duplicateRemote}/inbox`,
    remoteSharedInboxUri: null,
    followActivityUri: staleFollowUri,
  });
  assert.equal(stale?.outboxEnqueue, undefined);
  const refollow = await repository.recordInboundFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
    remoteActorUri: duplicateRemote,
    remoteInboxUri: `${duplicateRemote}/inbox`,
    remoteSharedInboxUri: null,
    followActivityUri: `${canonicalOrigin}/activitypub/activities/follow/refollow-new`,
  });
  assert.equal(refollow?.follow.status, 'accepted');
  assert.equal(refollow?.outboxEnqueue?.activityType, 'Accept');
}

async function assertEnqueueFailureRollsBackFollowState(sql: postgres.Sql) {
  const useCases = createActivityPubFollowUseCases({
    canonicalOrigin,
    sql,
    encryptionKey: Buffer.alloc(32, 99),
    remoteActorResolver: {
      resolve: async () => ({
        actorUri: 'https://remote.example/users/enqueue-rollback',
        inboxUri: 'https://remote.example/users/enqueue-rollback/inbox',
        sharedInboxUri: null,
      }),
    },
  });
  await assert.rejects(
    () =>
      useCases.requestOutboundFollow({
        projectSlug: fixtureProjectSlug,
        localActorId,
        localActorPreferredUsername: fixtureProjectSlug,
        localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
        remoteActorAddress: 'https://remote.example/users/enqueue-rollback',
      }),
    /decrypt|encrypt|key|enqueue/i,
  );
  const rows = await sql`
    SELECT id::text AS id
    FROM public.activitypub_follows
    WHERE remote_actor_uri = 'https://remote.example/users/enqueue-rollback'
  `;
  assert.equal(rows.length, 0);
}

async function assertInboundAcceptEnqueueFailureRollsBackFollowState(sql: postgres.Sql) {
  await cleanupFixture(sql);
  await seedFixture(sql);
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/inbound-enqueue-fail`;
  const useCases = createActivityPubFollowUseCases({
    canonicalOrigin,
    sql,
    encryptionKey: Buffer.alloc(32, 88),
    remoteActorResolver: {
      resolve: async () => ({
        actorUri: remoteActorUri,
        inboxUri: remoteInboxUri,
        sharedInboxUri: null,
      }),
    },
  });
  await assert.rejects(
    () =>
      useCases.processVerifiedInboundFollow({
        localActorId,
        localActorPreferredUsername: fixtureProjectSlug,
        localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
        localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
        remoteActorUri,
        remoteInboxUri,
        remoteSharedInboxUri: null,
        followActivityUri,
      }),
    /decrypt|encrypt|key|enqueue/i,
  );
  const followRows = await sql<{ id: string }[]>`
    SELECT id::text AS id
    FROM public.activitypub_follows
    WHERE follow_activity_uri = ${followActivityUri}
  `;
  assert.equal(followRows.length, 0);
  const activityRows = await sql<{ id: string }[]>`
    SELECT id::text AS id
    FROM public.activitypub_activities
    WHERE activity_uri = ${followActivityUri}
  `;
  assert.equal(activityRows.length, 0);
  const outboxRows = await sql<{ id: string }[]>`
    SELECT id::text AS id
    FROM public.activitypub_queue_messages
    WHERE queue_kind = 'outbox'
      AND dedupe_key LIKE ${`${canonicalOrigin}/activitypub/activities/accept%`}
  `;
  assert.equal(outboxRows.length, 0);
}

async function assertConcurrentOutboundFollowIsIdempotent(sql: postgres.Sql) {
  const remote = 'https://remote.example/users/concurrent';
  const clientA = postgres(resolvedDatabaseUrl, { max: 1 });
  const clientB = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    const repoA = createPostgresActivityPubFollowRepository({ sql: clientA });
    const repoB = createPostgresActivityPubFollowRepository({ sql: clientB });
    const [first, second] = await Promise.all([
      repoA.requestOutboundFollow({
        canonicalOrigin,
        localActorId,
        localActorPreferredUsername: fixtureProjectSlug,
        localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
        remoteActorUri: remote,
        remoteInboxUri: `${remote}/inbox`,
        remoteSharedInboxUri: null,
      }),
      repoB.requestOutboundFollow({
        canonicalOrigin,
        localActorId,
        localActorPreferredUsername: fixtureProjectSlug,
        localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
        remoteActorUri: remote,
        remoteInboxUri: `${remote}/inbox`,
        remoteSharedInboxUri: null,
      }),
    ]);
    assert.equal(first.follow.id, second.follow.id);
    assert.equal(first.follow.followActivityUri, second.follow.followActivityUri);
    const enqueueCount = [first.outboxEnqueue, second.outboxEnqueue].filter(Boolean).length;
    assert.equal(enqueueCount, 1);
    const rows = await sql`
      SELECT id::text AS id
      FROM public.activitypub_follows
      WHERE remote_actor_uri = ${remote}
    `;
    assert.equal(rows.length, 1);
  } finally {
    await clientA.end({ timeout: 5 });
    await clientB.end({ timeout: 5 });
  }
}

async function assertAcceptedOutboundUndoPreservesAcceptedAt(sql: postgres.Sql) {
  const repository = createPostgresActivityPubFollowRepository({ sql });
  const remote = 'https://remote.example/users/accepted-undo';
  const follow = await repository.requestOutboundFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    remoteActorUri: remote,
    remoteInboxUri: `${remote}/inbox`,
    remoteSharedInboxUri: null,
  });
  const accepted = await repository.recordOutboundAcceptReceipt({
    canonicalOrigin,
    localActorId,
    remoteActorUri: remote,
    followActivityUri: follow.follow.followActivityUri,
    activityUri: `${canonicalOrigin}/activitypub/activities/accept/db-accepted-undo`,
  });
  assert.ok(accepted?.follow.acceptedAt);
  const acceptedAt = accepted.follow.acceptedAt;
  const undone = await repository.requestOutboundUndo({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    remoteActorUri: remote,
    remoteInboxUri: `${remote}/inbox`,
    remoteSharedInboxUri: null,
  });
  assert.equal(undone?.follow.status, 'undone');
  assert.equal(undone?.follow.acceptedAt?.toISOString(), acceptedAt?.toISOString());
  assert.ok(undone?.follow.undoneAt);
}

async function assertStaleInboundUndoDoesNotCancelNewGeneration(sql: postgres.Sql) {
  const repository = createPostgresActivityPubFollowRepository({ sql });
  const remote = 'https://remote.example/users/stale-undo-db';
  const staleFollowUri = `${canonicalOrigin}/activitypub/activities/follow/stale-db`;
  const newFollowUri = `${canonicalOrigin}/activitypub/activities/follow/new-db`;
  await repository.recordInboundUndoFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
    remoteActorUri: remote,
    remoteInboxUri: `${remote}/inbox`,
    remoteSharedInboxUri: null,
    undoActivityUri: `${canonicalOrigin}/activitypub/activities/undo/stale-db`,
    embeddedFollowActivityUri: staleFollowUri,
  });
  const refollow = await repository.recordInboundFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
    remoteActorUri: remote,
    remoteInboxUri: `${remote}/inbox`,
    remoteSharedInboxUri: null,
    followActivityUri: newFollowUri,
  });
  assert.equal(refollow?.follow.status, 'accepted');
  const staleUndo = await repository.recordInboundUndoFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
    remoteActorUri: remote,
    remoteInboxUri: `${remote}/inbox`,
    remoteSharedInboxUri: null,
    undoActivityUri: `${canonicalOrigin}/activitypub/activities/undo/stale-after-db`,
    embeddedFollowActivityUri: staleFollowUri,
  });
  assert.equal(staleUndo?.follow.status, 'accepted');
  assert.equal(staleUndo?.follow.followActivityUri, newFollowUri);
}

async function assertMigration0017TimestampConstraints(sql: postgres.Sql) {
  const rows = await sql<{ conname: string }[]>`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.activitypub_follows'::regclass
      AND conname IN (
        'activitypub_follows_accepted_timestamp_check',
        'activitypub_follows_undone_timestamp_check'
      )
  `;
  assert.equal(rows.length, 2);
}

async function assertProjectScopedOutboundListing(sql: postgres.Sql) {
  const repository = createPostgresActivityPubFollowRepository({ sql });
  const listingRemote = 'https://remote.example/users/listing';
  await repository.requestOutboundFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    remoteActorUri: listingRemote,
    remoteInboxUri: `${listingRemote}/inbox`,
    remoteSharedInboxUri: null,
  });
  const follows = await repository.listProjectOutboundFollows({ projectId: fixtureProjectId });
  assert.ok(follows.some((follow) => follow.remoteActorUri === listingRemote));

  const inboundAccepted = await repository.recordInboundFollow({
    canonicalOrigin,
    localActorId,
    localActorPreferredUsername: fixtureProjectSlug,
    localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
    localActorUri: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`,
    remoteActorUri: 'https://remote.example/users/inbound-listing',
    remoteInboxUri: 'https://remote.example/inbox',
    remoteSharedInboxUri: null,
    followActivityUri: `${canonicalOrigin}/activitypub/activities/follow/inbound-listing`,
  });
  assert.ok(inboundAccepted?.follow.status === 'accepted');

  const page = await repository.listAcceptedFollows({
    localActorId,
    direction: 'inbound',
  });
  const total = await repository.countAcceptedFollows({
    localActorId,
    direction: 'inbound',
  });
  assert.equal(total, page.items.length);
}

async function assertTransactionRollback(sql: postgres.Sql) {
  const rollbackToken = 'rollback follow db test';
  await sql
    .begin(async (tx) => {
      const repository = createPostgresActivityPubFollowTransactionRepository({ sql: tx });
      await repository.requestOutboundFollow({
        canonicalOrigin,
        localActorId,
        localActorPreferredUsername: fixtureProjectSlug,
        localActorKeyId: `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`,
        remoteActorUri: 'https://remote.example/users/rollback',
        remoteInboxUri: 'https://remote.example/users/rollback/inbox',
        remoteSharedInboxUri: null,
      });
      throw new Error(rollbackToken);
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== rollbackToken) {
        throw error;
      }
    });

  const rows = await sql`
    SELECT id::text AS id
    FROM public.activitypub_follows
    WHERE remote_actor_uri = 'https://remote.example/users/rollback'
  `;
  assert.equal(rows.length, 0);
}
