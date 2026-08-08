import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { createPostgresActivityPubRepository } from './actor-repository.ts';
import {
  createVerifiedInboxContextForTest,
  invokeVerifiedInboundFollowListenerForTest,
} from './federation-follow-listeners.ts';
import { createFedifyInboxMessageFixture } from './fedify-message-fixture.ts';
import { buildFollowActivityFromJson } from './follow-inbox-listener-harness.ts';
import { createActivityPubFollowUseCases } from './follow-use-cases.ts';
import { createPostgresQueueAdapter, processOneQueuedMessage } from './postgres.ts';
import type { RemoteActorResolver } from './remote-actor.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!runDbTests) {
  console.log('Skipping follow inbox queue contract DB tests (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for follow inbox queue contract DB tests.');
}

const resolvedDatabaseUrl: string = databaseUrl;
const encryptionKey = Buffer.alloc(32, 21);
const canonicalOrigin = 'https://lens.test';
const fixtureProjectId = '4f000000-0000-0000-0000-00000000db31';
const fixtureProjectSlug = 'activitypub-inbox-queue-fixture';
let seededLocalActorId = '';
const remoteActorUri = 'https://remote.example/users/alice-inbox-queue';
const remoteInboxUri = `${remoteActorUri}/inbox`;
const localActorUri = `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}`;

await main();

async function main() {
  const sql = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    await cleanupFixture(sql);
    await assertClaimQueueUpdateHasNoDuplicateWorkerTokenAssignments();
    await assertVerifiedInboundFollowQueueProcessorPersistsAcceptedFollowAndAcceptOutbox(sql);
    await assertDuplicateInboundFollowQueueDeliveryHasNoExtraSideEffects(sql);
    await assertMismatchedSignedKeyOwnerRejectsInboundFollow(sql);
    await assertSharedInboxInboundFollowUsesRemoteSharedInbox(sql);
    console.log('activitypub follow inbox queue contract DB tests passed');
  } finally {
    await cleanupFixture(sql);
    await sql.end({ timeout: 5 });
  }
}

async function cleanupFixture(sql: postgres.Sql) {
  await sql`DELETE FROM public.activitypub_queue_messages WHERE dedupe_key LIKE ${`${canonicalOrigin}%`}`;
  if (seededLocalActorId) {
    await sql`DELETE FROM public.activitypub_follows WHERE local_actor_id = ${seededLocalActorId}::uuid`;
    await sql`DELETE FROM public.activitypub_activities WHERE local_actor_id = ${seededLocalActorId}::uuid`;
    await sql`DELETE FROM public.activitypub_actors WHERE id = ${seededLocalActorId}::uuid`;
  }
  await sql`DELETE FROM public.projects WHERE id = ${fixtureProjectId}::uuid`;
  seededLocalActorId = '';
}

async function seedFixture(sql: postgres.Sql) {
  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${fixtureProjectId}::uuid,
      ${fixtureProjectSlug},
      'Inbox Queue Fixture',
      'graph_activitypub_inbox_queue_fixture',
      ${fixtureProjectSlug},
      'public'
    )
  `;
  const actor = await actorRepository.enableProjectActor({
    projectId: fixtureProjectId,
    projectSlug: fixtureProjectSlug,
  });
  seededLocalActorId = actor.id;
}

function createTestRemoteActorResolver() {
  return {
    resolve: async () => ({
      actorUri: remoteActorUri,
      inboxUri: remoteInboxUri,
      sharedInboxUri: null,
    }),
  };
}

function createProcessInput(
  sql: postgres.Sql,
  actorRepository: ReturnType<typeof createPostgresActivityPubRepository>,
  testRemoteActorResolver?: RemoteActorResolver,
) {
  return {
    sql,
    canonicalOrigin,
    encryptionKey,
    actorRepository,
    testOnlyAllowPrivateAddress: true,
    ...(testRemoteActorResolver ? { testRemoteActorResolver } : {}),
  };
}

async function enqueueInboundFollow(
  sql: postgres.Sql,
  followActivityUri: string,
  identifier: string | null,
) {
  const queue = createPostgresQueueAdapter({ sql, canonicalOrigin });
  const inboxMessage = createFedifyInboxMessageFixture({
    baseUrl: canonicalOrigin,
    activity: {
      type: 'Follow',
      id: followActivityUri,
      actor: remoteActorUri,
      object: localActorUri,
    },
  });
  inboxMessage.identifier = identifier;
  await queue.enqueue(inboxMessage);
}

async function assertClaimQueueUpdateHasNoDuplicateWorkerTokenAssignments() {
  const postgresSource = await readFile(join(import.meta.dirname, 'postgres.ts'), 'utf8');
  const claimMatch = postgresSource.match(/async function claimQueueRow[\s\S]*?^}/m);
  assert.ok(claimMatch, 'claimQueueRow must exist in postgres.ts');
  const updateMatch = claimMatch[0].match(
    /UPDATE public\.activitypub_queue_messages[\s\S]*?RETURNING id/,
  );
  assert.ok(updateMatch, 'claimQueueRow must include queue claim UPDATE');
  const assignments = [...updateMatch[0].matchAll(/^\s+([a-z_]+)\s*=/gm)].map((match) => match[1]);
  const workerTokenAssignments = assignments.filter((name) => name === 'worker_token');
  assert.equal(
    workerTokenAssignments.length,
    1,
    'claimQueueRow UPDATE must assign worker_token exactly once',
  );
}

async function assertVerifiedInboundFollowQueueProcessorPersistsAcceptedFollowAndAcceptOutbox(
  sql: postgres.Sql,
) {
  await cleanupFixture(sql);
  await seedFixture(sql);
  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  const testResolver = createTestRemoteActorResolver();
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/inbox-queue-1`;
  await enqueueInboundFollow(sql, followActivityUri, fixtureProjectSlug);

  const result = await processOneQueuedMessage(
    createProcessInput(sql, actorRepository, testResolver),
  );
  assert.equal(result.status, 'processed');

  const followRows = await sql<{ status: string }[]>`
    SELECT status
    FROM public.activitypub_follows
    WHERE local_actor_id = ${seededLocalActorId}::uuid
      AND direction = 'inbound'
  `;
  assert.equal(followRows[0]?.status, 'accepted');

  const acceptRows = await sql<{ queue_kind: string }[]>`
    SELECT queue_kind
    FROM public.activitypub_queue_messages
    WHERE queue_kind = 'outbox'
      AND dedupe_key LIKE ${`${canonicalOrigin}/activitypub/activities/accept/%`}
  `;
  assert.equal(acceptRows.length, 1);
}

async function assertDuplicateInboundFollowQueueDeliveryHasNoExtraSideEffects(sql: postgres.Sql) {
  await cleanupFixture(sql);
  await seedFixture(sql);
  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  const testResolver = createTestRemoteActorResolver();
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/inbox-queue-dup`;
  await enqueueInboundFollow(sql, followActivityUri, fixtureProjectSlug);
  await processOneQueuedMessage(createProcessInput(sql, actorRepository, testResolver));
  await enqueueInboundFollow(sql, followActivityUri, fixtureProjectSlug);

  const acceptRows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM public.activitypub_queue_messages
    WHERE queue_kind = 'outbox'
      AND dedupe_key LIKE ${`${canonicalOrigin}/activitypub/activities/accept/%`}
  `;
  assert.equal(acceptRows[0]?.count, '1');
}

async function assertMismatchedSignedKeyOwnerRejectsInboundFollow(sql: postgres.Sql) {
  await cleanupFixture(sql);
  await seedFixture(sql);
  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  const followUseCases = createActivityPubFollowUseCases({
    canonicalOrigin,
    sql,
    encryptionKey,
    actorRepository,
    remoteActorResolver: createTestRemoteActorResolver(),
  });
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/inbox-queue-mismatch`;
  const activity = buildFollowActivityFromJson({
    type: 'Follow',
    id: followActivityUri,
    actor: remoteActorUri,
    object: localActorUri,
  });
  const ctx = createVerifiedInboxContextForTest({
    recipient: fixtureProjectSlug,
    signedActorUri: 'https://evil.example/users/not-alice',
  });
  await invokeVerifiedInboundFollowListenerForTest({
    canonicalOrigin,
    actorRepository,
    followUseCases,
    ctx,
    activity,
  });

  const followRows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM public.activitypub_follows
    WHERE local_actor_id = ${seededLocalActorId}::uuid
  `;
  assert.equal(followRows[0]?.count, '0');
}

async function assertSharedInboxInboundFollowUsesRemoteSharedInbox(sql: postgres.Sql) {
  await cleanupFixture(sql);
  await seedFixture(sql);
  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  const remoteSharedInboxUri = 'https://remote.example/inbox';
  const testResolver = {
    resolve: async () => ({
      actorUri: remoteActorUri,
      inboxUri: remoteInboxUri,
      sharedInboxUri: remoteSharedInboxUri,
    }),
  };
  const followActivityUri = `${canonicalOrigin}/activitypub/activities/follow/inbox-queue-shared`;
  await enqueueInboundFollow(sql, followActivityUri, null);
  const result = await processOneQueuedMessage(
    createProcessInput(sql, actorRepository, testResolver),
  );
  assert.equal(result.status, 'processed');

  const acceptRows = await sql<
    {
      recipient_origin: string | null;
      message_json: {
        inbox?: string;
        sharedInbox?: boolean;
      };
    }[]
  >`
    SELECT recipient_origin, message_json
    FROM public.activitypub_queue_messages
    WHERE queue_kind = 'outbox'
      AND dedupe_key LIKE ${`${canonicalOrigin}/activitypub/activities/accept/%`}
  `;
  assert.equal(acceptRows.length, 1);
  assert.equal(acceptRows[0]?.message_json.inbox, remoteSharedInboxUri);
  assert.equal(acceptRows[0]?.message_json.sharedInbox, true);
  assert.equal(acceptRows[0]?.recipient_origin, 'https://remote.example');
}
