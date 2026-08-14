import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createPostgresActivityPubRepository } from './actor-repository.ts';
import { runActivityPubDispatcherOnce } from './postgres-dispatcher.ts';
import { buildOutboxDedupeKey } from './queue.ts';
import {
  buildStableAnnounceActivityUri,
  buildStableCreateActivityUri,
} from './report-activity-uris.ts';
import { enqueueReportPublicationOutbox } from './report-publication-outbox.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!runDbTests) {
  console.log('Skipping dispatcher single-connection DB tests (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for dispatcher single-connection DB tests.');
}

const resolvedDatabaseUrl: string = databaseUrl;
const encryptionKey = Buffer.alloc(32, 77);
const canonicalOrigin = 'https://lens.test';
const projectId = '4f000000-0000-0000-0000-00000000db61';
const reportId = '4f000000-0000-0000-0000-00000000db62';
const aggregateActorId = '4f000000-0000-0000-0000-00000000db63';
const projectSlug = 'dispatcher-single-connection-fixture';
const remoteOrigin = 'https://dispatcher-single-connection.example';
const remoteActorUri = `${remoteOrigin}/users/follower`;
const remoteInboxUri = `${remoteActorUri}/inbox`;
const publishedAt = new Date('2026-01-15T12:00:00.000Z');

let resolvedAggregateActorId = aggregateActorId;
let reusedPreExistingAggregate = false;
let savedAggregateEnabled: boolean | null = null;
let seededProjectActorId = '';
const encryptedPrivateKey = {
  version: 1,
  algorithm: 'aes-256-gcm',
  iv: 'aXY=',
  ciphertext: 'YQ==',
  tag: 'dGFn',
} as const;

await main();

async function main() {
  const sql = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    await sql`SET idle_in_transaction_session_timeout = '5s'`;
    await cleanup(sql);
    await seedFixture(sql);
    await assertDispatcherMaterializesCreateWithoutDeadlock(sql);
    console.log('activitypub dispatcher single-connection DB tests passed');
  } finally {
    await cleanup(sql);
    await sql.end({ timeout: 5 });
  }
}

async function cleanup(sql: postgres.Sql) {
  await sql`
    DELETE FROM public.activitypub_queue_messages
    WHERE recipient_origin = ${remoteOrigin}
  `;
  await sql`
    DELETE FROM public.activitypub_follows
    WHERE local_actor_id IN (
      SELECT id
      FROM public.activitypub_actors
      WHERE kind = 'project'
        AND project_id = ${projectId}::uuid
    )
  `;
  await sql`
    DELETE FROM public.activitypub_activities
    WHERE payload_json->>'reportId' = ${reportId}
      OR local_actor_id IN (
        SELECT id
        FROM public.activitypub_actors
        WHERE kind = 'project'
          AND project_id = ${projectId}::uuid
      )
  `;
  await sql`DELETE FROM public.reports WHERE id = ${reportId}::uuid`;
  await sql`
    DELETE FROM public.activitypub_actors
    WHERE kind = 'project'
      AND project_id = ${projectId}::uuid
  `;
  await sql`DELETE FROM public.projects WHERE id = ${projectId}::uuid`;
  await sql`
    DELETE FROM public.activitypub_follows
    WHERE local_actor_id = ${aggregateActorId}::uuid
  `;
  await sql`
    DELETE FROM public.activitypub_activities
    WHERE local_actor_id = ${aggregateActorId}::uuid
  `;
  await sql`
    DELETE FROM public.activitypub_actors
    WHERE id = ${aggregateActorId}::uuid
  `;
  if (reusedPreExistingAggregate && savedAggregateEnabled !== null) {
    await sql`
      UPDATE public.activitypub_actors
      SET enabled = ${savedAggregateEnabled}
      WHERE id = ${resolvedAggregateActorId}::uuid
    `;
  }
  seededProjectActorId = '';
}

async function seedFixture(sql: postgres.Sql) {
  const existingAggregate = await sql<{ id: string; enabled: boolean }[]>`
    SELECT id::text AS id, enabled
    FROM public.activitypub_actors
    WHERE kind = 'aggregate'
    LIMIT 1
  `;
  if (existingAggregate[0] && existingAggregate[0].id !== aggregateActorId) {
    resolvedAggregateActorId = existingAggregate[0].id;
    reusedPreExistingAggregate = true;
    savedAggregateEnabled = existingAggregate[0].enabled;
    if (!existingAggregate[0].enabled) {
      await sql`
        UPDATE public.activitypub_actors
        SET enabled = true
        WHERE id = ${resolvedAggregateActorId}::uuid
      `;
    }
  } else {
    resolvedAggregateActorId = aggregateActorId;
    reusedPreExistingAggregate = false;
    savedAggregateEnabled = null;
    await sql`
      INSERT INTO public.activitypub_actors (
        id, project_id, kind, preferred_username, display_name, enabled, public_key_pem, encrypted_private_key
      )
      VALUES (
        ${aggregateActorId}::uuid,
        NULL,
        'aggregate',
        'all',
        'Aggregate',
        true,
        '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2\n4vl4Z2TLpqbb5CHmpSMgAS5KdEcTRL+RscJ0dHqN0NvdWT7qfB8xtB2LBvOkvUs\n7Y8YkPeDlaPk9N6pRSZ0WQgWwgQnR5UwP09NuoGfeDmGg8A32gs2WnLvvHQgkPw\nIDAQAB\n-----END PUBLIC KEY-----',
        ${sql.json(encryptedPrivateKey as never)}
      )
    `;
  }

  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${projectId}::uuid,
      ${projectSlug},
      'Dispatcher Single Connection Fixture',
      'graph_dispatcher_single_connection_fixture',
      ${projectSlug},
      'public'
    )
  `;
  await sql`
    INSERT INTO public.reports (id, project_id, title, storage_uri, is_public)
    VALUES (${reportId}::uuid, ${projectId}::uuid, 'Fixture Report', 'gs://fixture/report', false)
  `;
  const actor = await actorRepository.enableProjectActor({
    projectId,
    projectSlug,
  });
  seededProjectActorId = actor.id;

  await sql`
    INSERT INTO public.activitypub_follows (
      id,
      direction,
      local_actor_id,
      remote_actor_uri,
      remote_inbox_uri,
      remote_shared_inbox_uri,
      follow_activity_uri,
      status,
      accepted_at
    )
    VALUES (
      ${randomUUID()}::uuid,
      'inbound',
      ${seededProjectActorId}::uuid,
      ${remoteActorUri},
      ${remoteInboxUri},
      NULL,
      ${`${remoteOrigin}/activities/follow/${projectSlug}`},
      'accepted',
      ${publishedAt}
    )
  `;
}

async function assertDispatcherMaterializesCreateWithoutDeadlock(sql: postgres.Sql) {
  await sql.begin(async (transaction) => {
    await enqueueReportPublicationOutbox({
      sql: transaction,
      canonicalOrigin,
      projectId,
      reportId,
      publishedAt,
      publicSummary: 'public summary',
    });
  });

  const announceActivityUri = buildStableAnnounceActivityUri({ canonicalOrigin, reportId });
  await sql`
    DELETE FROM public.activitypub_activities
    WHERE activity_uri = ${announceActivityUri}
  `;

  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  const result = await runActivityPubDispatcherOnce({
    sql,
    canonicalOrigin,
    encryptionKey,
    actorRepository,
    maxBatchSize: 1,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.activitiesMaterialized, 1);

  const createActivityUri = buildStableCreateActivityUri({ canonicalOrigin, reportId });
  const activityRows = await sql<{ processing_status: string }[]>`
    SELECT processing_status
    FROM public.activitypub_activities
    WHERE activity_uri = ${createActivityUri}
  `;
  assert.equal(activityRows[0]?.processing_status, 'processed');

  const queueRows = await sql<
    { status: string; recipient_origin: string | null; dedupe_key: string }[]
  >`
    SELECT status, recipient_origin, dedupe_key
    FROM public.activitypub_queue_messages
    WHERE recipient_origin = ${remoteOrigin}
  `;
  assert.equal(queueRows.length, 1);
  assert.equal(queueRows[0]?.status, 'pending');
  assert.equal(queueRows[0]?.recipient_origin, remoteOrigin);
  assert.equal(
    queueRows[0]?.dedupe_key,
    buildOutboxDedupeKey({ activityId: createActivityUri, recipientInbox: remoteInboxUri }),
  );
}
