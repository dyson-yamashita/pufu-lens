import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  buildStableAnnounceActivityUri,
  buildStableCreateActivityUri,
} from './report-activity-uris.ts';
import {
  enqueueReportPublicationOutbox,
  ReportPublicationAggregateActorError,
} from './report-publication-outbox.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!runDbTests) {
  console.log('Skipping report publication outbox DB tests (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for report publication outbox DB tests.');
}

const resolvedDatabaseUrl: string = databaseUrl;

const canonicalOrigin = 'https://lens.test';
const projectId = '4f000000-0000-0000-0000-00000000db21';
const privateProjectId = '4f000000-0000-0000-0000-00000000db22';
const projectSlug = 'activitypub-publication-db-fixture';
const privateProjectSlug = 'activitypub-publication-private-fixture';
const projectActorId = '4f000000-0000-0000-0000-00000000db23';
const aggregateActorId = '4f000000-0000-0000-0000-00000000db24';
const disabledProjectActorId = '4f000000-0000-0000-0000-00000000db25';
const disabledProjectId = '4f000000-0000-0000-0000-00000000db26';
const disabledProjectSlug = 'activitypub-publication-disabled-fixture';
const reportId = '4f000000-0000-0000-0000-00000000db27';
const publishedAt = new Date('2026-01-15T12:00:00.000Z');
let resolvedAggregateActorId = aggregateActorId;
let createdFixtureAggregate = false;
let savedAggregateEnabled: boolean | null = null;
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
    await cleanup(sql);
    await seedBaseFixture(sql);
    await assertPublicProjectEnqueuesCreateAndAnnounce(sql);
    await assertIdempotentRepeat(sql);
    await assertPublicWithoutApTimestampStillEnqueues(sql);
    await assertPrivateProjectUpdatesWithoutActivities(sql);
    await assertDisabledProjectActorUpdatesWithoutActivities(sql);
    await assertMissingAggregateRollsBack(sql);
    await assertEmptySummaryStillEnqueues(sql);
    await assertForcedRollbackAfterEnqueue(sql);
    await assertRepresentationLockOnlyOnPublicEnabledSuccess(sql);
    console.log('activitypub report publication outbox DB tests passed');
  } finally {
    await cleanup(sql);
    await sql.end({ timeout: 5 });
  }
}

async function cleanup(sql: postgres.Sql) {
  await sql`
    DELETE FROM public.activitypub_activities
    WHERE local_actor_id IN (${projectActorId}::uuid, ${resolvedAggregateActorId}::uuid, ${disabledProjectActorId}::uuid)
      OR payload_json->>'reportId' IN (
        SELECT id::text
        FROM public.reports
        WHERE project_id IN (${projectId}::uuid, ${privateProjectId}::uuid, ${disabledProjectId}::uuid)
      )
  `;
  await sql`
    DELETE FROM public.reports
    WHERE project_id IN (${projectId}::uuid, ${privateProjectId}::uuid, ${disabledProjectId}::uuid)
  `;
  await sql`DELETE FROM public.activitypub_actors WHERE id IN (${projectActorId}::uuid, ${disabledProjectActorId}::uuid)`;
  if (createdFixtureAggregate) {
    await sql`DELETE FROM public.activitypub_actors WHERE id = ${resolvedAggregateActorId}::uuid`;
  } else if (savedAggregateEnabled !== null) {
    await sql`
      UPDATE public.activitypub_actors
      SET enabled = ${savedAggregateEnabled}
      WHERE id = ${resolvedAggregateActorId}::uuid
    `;
  }
  await sql`DELETE FROM public.projects WHERE id IN (${projectId}::uuid, ${privateProjectId}::uuid, ${disabledProjectId}::uuid)`;
}

async function seedBaseFixture(sql: postgres.Sql) {
  const existingAggregate = await sql<{ id: string; enabled: boolean }[]>`
    SELECT id::text AS id, enabled
    FROM public.activitypub_actors
    WHERE kind = 'aggregate'
    LIMIT 1
  `;
  if (existingAggregate[0]) {
    resolvedAggregateActorId = existingAggregate[0].id;
    createdFixtureAggregate = false;
    savedAggregateEnabled = existingAggregate[0].enabled;
  } else {
    resolvedAggregateActorId = aggregateActorId;
    createdFixtureAggregate = true;
    savedAggregateEnabled = true;
  }
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES
      (${projectId}::uuid, ${projectSlug}, 'Publication Fixture', 'graph_publication_fixture', ${projectSlug}, 'public'),
      (${privateProjectId}::uuid, ${privateProjectSlug}, 'Private Fixture', 'graph_private_fixture', ${privateProjectSlug}, 'private'),
      (${disabledProjectId}::uuid, ${disabledProjectSlug}, 'Disabled Fixture', 'graph_disabled_fixture', ${disabledProjectSlug}, 'public')
  `;
  await sql`
    INSERT INTO public.reports (id, project_id, title, storage_uri, is_public)
    VALUES (${reportId}::uuid, ${projectId}::uuid, 'Fixture Report', 'gs://fixture/report', false)
  `;
  await sql`
    INSERT INTO public.activitypub_actors (
      id, project_id, kind, preferred_username, display_name, enabled, public_key_pem, encrypted_private_key
    )
    VALUES
      (${projectActorId}::uuid, ${projectId}::uuid, 'project', ${projectSlug}, 'Project', true, '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2\n4vl4Z2TLpqbb5CHmpSMgAS5KdEcTRL+RscJ0dHqN0NvdWT7qfB8xtB2LBvOkvUs\n7Y8YkPeDlaPk9N6pRSZ0WQgWwgQnR5UwP09NuoGfeDmGg8A32gs2WnLvvHQgkPw\nIDAQAB\n-----END PUBLIC KEY-----', ${sql.json(encryptedPrivateKey as never)}),
      (${disabledProjectActorId}::uuid, ${disabledProjectId}::uuid, 'project', ${disabledProjectSlug}, 'Disabled', false, '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2\n4vl4Z2TLpqbb5CHmpSMgAS5KdEcTRL+RscJ0dHqN0NvdWT7qfB8xtB2LBvOkvUs\n7Y8YkPeDlaPk9N6pRSZ0WQgWwgQnR5UwP09NuoGfeDmGg8A32gs2WnLvvHQgkPw\nIDAQAB\n-----END PUBLIC KEY-----', ${sql.json(encryptedPrivateKey as never)})
  `;
  if (createdFixtureAggregate) {
    await sql`
      INSERT INTO public.activitypub_actors (
        id, project_id, kind, preferred_username, display_name, enabled, public_key_pem, encrypted_private_key
      )
      VALUES (
        ${resolvedAggregateActorId}::uuid,
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
}

async function assertPublicProjectEnqueuesCreateAndAnnounce(sql: postgres.Sql) {
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
  const report = await sql`
    SELECT is_public, activitypub_public_summary
    FROM public.reports
    WHERE id = ${reportId}::uuid
  `;
  assert.equal(report[0]?.is_public, true);
  const activities = await sql`
    SELECT activity_type, activity_uri
    FROM public.activitypub_activities
    WHERE direction = 'outbound'
      AND payload_json->>'reportId' = ${reportId}
    ORDER BY activity_type ASC
  `;
  assert.equal(activities.length, 2);
  const create = activities.find((activity) => activity.activity_type === 'Create');
  const announce = activities.find((activity) => activity.activity_type === 'Announce');
  assert.equal(create?.activity_uri, buildStableCreateActivityUri({ canonicalOrigin, reportId }));
  assert.equal(
    announce?.activity_uri,
    buildStableAnnounceActivityUri({ canonicalOrigin, reportId }),
  );
}

async function assertIdempotentRepeat(sql: postgres.Sql) {
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
  const activities = await sql`
    SELECT count(*)::int AS count
    FROM public.activitypub_activities
    WHERE direction = 'outbound'
      AND payload_json->>'reportId' = ${reportId}
  `;
  assert.equal(activities[0]?.count, 2);
}

async function assertPrivateProjectUpdatesWithoutActivities(sql: postgres.Sql) {
  const privateReportId = '4f000000-0000-0000-0000-00000000db28';
  await sql`DELETE FROM public.reports WHERE id = ${privateReportId}::uuid`;
  await sql`
    INSERT INTO public.reports (id, project_id, title, storage_uri, is_public)
    VALUES (${privateReportId}::uuid, ${privateProjectId}::uuid, 'Private Report', 'gs://fixture/private', false)
  `;
  await sql.begin(async (transaction) => {
    await enqueueReportPublicationOutbox({
      sql: transaction,
      canonicalOrigin,
      projectId: privateProjectId,
      reportId: privateReportId,
      publishedAt,
      publicSummary: 'private summary',
    });
  });
  const report =
    await sql`SELECT is_public FROM public.reports WHERE id = ${privateReportId}::uuid`;
  assert.equal(report[0]?.is_public, true);
  const activities = await sql`
    SELECT count(*)::int AS count
    FROM public.activitypub_activities
    WHERE payload_json->>'reportId' = ${privateReportId}
  `;
  assert.equal(activities[0]?.count, 0);
}

async function assertDisabledProjectActorUpdatesWithoutActivities(sql: postgres.Sql) {
  const disabledReportId = '4f000000-0000-0000-0000-00000000db29';
  await sql`DELETE FROM public.reports WHERE id = ${disabledReportId}::uuid`;
  await sql`
    INSERT INTO public.reports (id, project_id, title, storage_uri, is_public)
    VALUES (${disabledReportId}::uuid, ${disabledProjectId}::uuid, 'Disabled Report', 'gs://fixture/disabled', false)
  `;
  await sql.begin(async (transaction) => {
    await enqueueReportPublicationOutbox({
      sql: transaction,
      canonicalOrigin,
      projectId: disabledProjectId,
      reportId: disabledReportId,
      publishedAt,
      publicSummary: 'disabled summary',
    });
  });
  const activities = await sql`
    SELECT count(*)::int AS count
    FROM public.activitypub_activities
    WHERE payload_json->>'reportId' = ${disabledReportId}
  `;
  assert.equal(activities[0]?.count, 0);
}

async function assertPublicWithoutApTimestampStillEnqueues(sql: postgres.Sql) {
  const partialReportId = '4f000000-0000-0000-0000-00000000db33';
  await sql`DELETE FROM public.activitypub_activities WHERE payload_json->>'reportId' = ${partialReportId}`;
  await sql`DELETE FROM public.reports WHERE id = ${partialReportId}::uuid`;
  await sql`
    INSERT INTO public.reports (
      id, project_id, title, storage_uri, is_public, activitypub_published_at, activitypub_public_summary
    )
    VALUES (
      ${partialReportId}::uuid,
      ${projectId}::uuid,
      'Partial Public Report',
      'gs://fixture/partial',
      true,
      NULL,
      NULL
    )
  `;
  await sql.begin(async (transaction) => {
    await enqueueReportPublicationOutbox({
      sql: transaction,
      canonicalOrigin,
      projectId,
      reportId: partialReportId,
      publishedAt,
      publicSummary: 'recovered summary',
    });
  });
  const activities = await sql`
    SELECT count(*)::int AS count
    FROM public.activitypub_activities
    WHERE direction = 'outbound'
      AND payload_json->>'reportId' = ${partialReportId}
  `;
  assert.equal(activities[0]?.count, 2);
}

async function assertMissingAggregateRollsBack(sql: postgres.Sql) {
  const rollbackReportId = '4f000000-0000-0000-0000-00000000db30';
  await sql`DELETE FROM public.reports WHERE id = ${rollbackReportId}::uuid`;
  await sql`
    INSERT INTO public.reports (id, project_id, title, storage_uri, is_public)
    VALUES (${rollbackReportId}::uuid, ${projectId}::uuid, 'Rollback Report', 'gs://fixture/rollback', false)
  `;
  const previousEnabled =
    (
      await sql<{ enabled: boolean }[]>`
        SELECT enabled
        FROM public.activitypub_actors
        WHERE id = ${resolvedAggregateActorId}::uuid
      `
    )[0]?.enabled ?? true;
  await sql`
    UPDATE public.activitypub_actors
    SET enabled = false
    WHERE id = ${resolvedAggregateActorId}::uuid
  `;
  try {
    await assert.rejects(
      () =>
        sql.begin(async (transaction) => {
          await enqueueReportPublicationOutbox({
            sql: transaction,
            canonicalOrigin,
            projectId,
            reportId: rollbackReportId,
            publishedAt,
            publicSummary: 'rollback summary',
          });
        }),
      ReportPublicationAggregateActorError,
    );
    const report =
      await sql`SELECT is_public FROM public.reports WHERE id = ${rollbackReportId}::uuid`;
    assert.equal(report[0]?.is_public, false);
  } finally {
    await sql`
      UPDATE public.activitypub_actors
      SET enabled = ${previousEnabled}
      WHERE id = ${resolvedAggregateActorId}::uuid
    `;
  }
}

async function assertEmptySummaryStillEnqueues(sql: postgres.Sql) {
  const emptyReportId = '4f000000-0000-0000-0000-00000000db31';
  await sql`DELETE FROM public.activitypub_activities WHERE payload_json->>'reportId' = ${emptyReportId}`;
  await sql`DELETE FROM public.reports WHERE id = ${emptyReportId}::uuid`;
  await sql`
    INSERT INTO public.reports (id, project_id, title, storage_uri, is_public)
    VALUES (${emptyReportId}::uuid, ${projectId}::uuid, 'Empty Summary', 'gs://fixture/empty', false)
  `;
  await sql.begin(async (transaction) => {
    await enqueueReportPublicationOutbox({
      sql: transaction,
      canonicalOrigin,
      projectId,
      reportId: emptyReportId,
      publishedAt,
      publicSummary: '',
    });
  });
  const report = await sql`
    SELECT activitypub_public_summary
    FROM public.reports
    WHERE id = ${emptyReportId}::uuid
  `;
  assert.equal(report[0]?.activitypub_public_summary, '');
}

async function assertForcedRollbackAfterEnqueue(sql: postgres.Sql) {
  const rollbackToken = 'rollback publication outbox test';
  const forcedReportId = '4f000000-0000-0000-0000-00000000db32';
  await sql`DELETE FROM public.reports WHERE id = ${forcedReportId}::uuid`;
  await sql`
    INSERT INTO public.reports (id, project_id, title, storage_uri, is_public)
    VALUES (${forcedReportId}::uuid, ${projectId}::uuid, 'Forced Rollback', 'gs://fixture/forced', false)
  `;
  await sql
    .begin(async (transaction) => {
      await enqueueReportPublicationOutbox({
        sql: transaction,
        canonicalOrigin,
        projectId,
        reportId: forcedReportId,
        publishedAt,
        publicSummary: 'forced rollback',
      });
      throw new Error(rollbackToken);
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== rollbackToken) {
        throw error;
      }
    });
  const report = await sql`SELECT is_public FROM public.reports WHERE id = ${forcedReportId}::uuid`;
  assert.equal(report[0]?.is_public, false);
}

async function assertRepresentationLockOnlyOnPublicEnabledSuccess(sql: postgres.Sql) {
  const initialLock = await sql<{ representation_locked_at: Date | null }[]>`
    SELECT representation_locked_at
    FROM public.activitypub_instance_config
    WHERE id = 1
  `;
  assert.ok(
    initialLock[0]?.representation_locked_at,
    'public enabled publication must lock representation before this assertion',
  );
  const lockedAt = initialLock[0]?.representation_locked_at;

  const privateReportId = '4f000000-0000-0000-0000-00000000db33';
  await sql`DELETE FROM public.reports WHERE id = ${privateReportId}::uuid`;
  await sql`
    INSERT INTO public.reports (id, project_id, title, storage_uri, is_public)
    VALUES (${privateReportId}::uuid, ${privateProjectId}::uuid, 'Private Lock', 'gs://fixture/private-lock', false)
  `;
  await sql.begin(async (transaction) => {
    await enqueueReportPublicationOutbox({
      sql: transaction,
      canonicalOrigin,
      projectId: privateProjectId,
      reportId: privateReportId,
      publishedAt,
      publicSummary: 'private summary',
    });
  });
  const privateLock = await sql<{ representation_locked_at: Date | null }[]>`
    SELECT representation_locked_at FROM public.activitypub_instance_config WHERE id = 1
  `;
  assert.equal(privateLock[0]?.representation_locked_at?.toISOString(), lockedAt?.toISOString());

  const disabledReportId = '4f000000-0000-0000-0000-00000000db34';
  await sql`DELETE FROM public.reports WHERE id = ${disabledReportId}::uuid`;
  await sql`
    INSERT INTO public.reports (id, project_id, title, storage_uri, is_public)
    VALUES (${disabledReportId}::uuid, ${disabledProjectId}::uuid, 'Disabled Lock', 'gs://fixture/disabled-lock', false)
  `;
  await sql.begin(async (transaction) => {
    await enqueueReportPublicationOutbox({
      sql: transaction,
      canonicalOrigin,
      projectId: disabledProjectId,
      reportId: disabledReportId,
      publishedAt,
      publicSummary: 'disabled summary',
    });
  });
  const disabledLock = await sql<{ representation_locked_at: Date | null }[]>`
    SELECT representation_locked_at FROM public.activitypub_instance_config WHERE id = 1
  `;
  assert.equal(disabledLock[0]?.representation_locked_at?.toISOString(), lockedAt?.toISOString());

  const rollbackReportId = '4f000000-0000-0000-0000-00000000db35';
  await sql`DELETE FROM public.reports WHERE id = ${rollbackReportId}::uuid`;
  await sql`
    INSERT INTO public.reports (id, project_id, title, storage_uri, is_public)
    VALUES (${rollbackReportId}::uuid, ${projectId}::uuid, 'Rollback Lock', 'gs://fixture/rollback-lock', false)
  `;
  const previousAggregateEnabled =
    (
      await sql<{ enabled: boolean }[]>`
        SELECT enabled
        FROM public.activitypub_actors
        WHERE id = ${resolvedAggregateActorId}::uuid
      `
    )[0]?.enabled ?? true;
  await sql`
    UPDATE public.activitypub_actors
    SET enabled = false
    WHERE id = ${resolvedAggregateActorId}::uuid
  `;
  try {
    await assert.rejects(
      () =>
        sql.begin(async (transaction) => {
          await enqueueReportPublicationOutbox({
            sql: transaction,
            canonicalOrigin,
            projectId,
            reportId: rollbackReportId,
            publishedAt,
            publicSummary: 'rollback lock summary',
          });
        }),
      ReportPublicationAggregateActorError,
    );
  } finally {
    await sql`
      UPDATE public.activitypub_actors
      SET enabled = ${previousAggregateEnabled}
      WHERE id = ${resolvedAggregateActorId}::uuid
    `;
  }
  const rollbackLock = await sql<{ representation_locked_at: Date | null }[]>`
    SELECT representation_locked_at FROM public.activitypub_instance_config WHERE id = 1
  `;
  assert.equal(rollbackLock[0]?.representation_locked_at?.toISOString(), lockedAt?.toISOString());
}
