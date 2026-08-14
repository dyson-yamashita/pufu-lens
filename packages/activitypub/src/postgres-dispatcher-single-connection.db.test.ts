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
import {
  parseActivityPubActivityRow,
  parseActivityPubActorRow,
  parseActivityPubQueueMessageRow,
  parseOptionalRow,
  parseRequiredRow,
  readSqlRows,
} from './schema.ts';

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
const projectSlug = 'dispatcher-single-connection-fixture';
const remoteOrigin = 'https://dispatcher-single-connection.example';
const remoteActorUri = `${remoteOrigin}/users/follower`;
const remoteInboxUri = `${remoteActorUri}/inbox`;
const publishedAt = new Date('2026-01-15T12:00:00.000Z');

let aggregateActorId = '';
let createdAggregateThisRun = false;
let savedAggregateEnabled: boolean | null = null;
let seededProjectActorId = '';

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
  if (createdAggregateThisRun && aggregateActorId) {
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
  } else if (savedAggregateEnabled !== null && aggregateActorId) {
    await sql`
      UPDATE public.activitypub_actors
      SET enabled = ${savedAggregateEnabled}
      WHERE id = ${aggregateActorId}::uuid
    `;
  }
  seededProjectActorId = '';
}

async function seedFixture(sql: postgres.Sql) {
  const existingAggregate = parseOptionalRow(
    readSqlRows(
      await sql`
      SELECT *
      FROM public.activitypub_actors
      WHERE kind = 'aggregate'
      LIMIT 1
    `,
    ),
    parseActivityPubActorRow,
  );
  createdAggregateThisRun = existingAggregate === undefined;
  savedAggregateEnabled = existingAggregate?.enabled ?? null;

  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  const aggregateActor = await actorRepository.ensureAggregateActor();
  aggregateActorId = aggregateActor.id;

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
  const activity = parseRequiredRow(
    readSqlRows(
      await sql`
      SELECT *
      FROM public.activitypub_activities
      WHERE activity_uri = ${createActivityUri}
    `,
    ),
    parseActivityPubActivityRow,
  );
  assert.equal(activity.processingStatus, 'processed');

  const queueRows = readSqlRows(
    await sql`
    SELECT *
    FROM public.activitypub_queue_messages
    WHERE recipient_origin = ${remoteOrigin}
  `,
  ).map(parseActivityPubQueueMessageRow);
  assert.equal(queueRows.length, 1);
  assert.equal(queueRows[0]?.status, 'pending');
  assert.equal(queueRows[0]?.recipientOrigin, remoteOrigin);
  assert.equal(
    queueRows[0]?.dedupeKey,
    buildOutboxDedupeKey({ activityId: createActivityUri, recipientInbox: remoteInboxUri }),
  );
}
