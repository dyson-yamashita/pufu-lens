import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createPostgresFederatedReportRepository } from './federated-report-repository.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!runDbTests) {
  console.log('Skipping federated report repository DB tests (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for federated report repository DB tests.');
}

const resolvedDatabaseUrl: string = databaseUrl;
const fixtureProjectId = '4f000000-0000-0000-0000-00000000db21';
const secondaryProjectId = '4f000000-0000-0000-0000-00000000db22';
const localActorId = '4f000000-0000-0000-0000-00000000db23';
const secondaryActorId = '4f000000-0000-0000-0000-00000000db24';
const fixtureProjectSlug = 'activitypub-report-db-fixture';
const secondaryProjectSlug = 'activitypub-report-db-fixture-b';
const remoteActorUri = 'https://remote.example/users/alice';
const remoteInboxUri = `${remoteActorUri}/inbox`;
const pendingRemoteActorUri = 'https://remote.example/users/pending-bob';
const pendingRemoteInboxUri = `${pendingRemoteActorUri}/inbox`;
const undoneRemoteActorUri = 'https://remote.example/users/undone-carol';
const undoneRemoteInboxUri = `${undoneRemoteActorUri}/inbox`;
const undoneTriggerRemoteActorUri = 'https://remote.example/users/undone-trigger-dave';
const undoneTriggerRemoteInboxUri = `${undoneTriggerRemoteActorUri}/inbox`;

await main();

async function main() {
  const sql = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    await cleanupFixture(sql);
    await seedFixture(sql);
    await assertPersonalThenSharedFanIn(sql);
    await assertCreateThenAnnounceSameObject(sql);
    await assertAnnounceThenCreateSameObject(sql);
    await assertActivityUriSpoofRejected(sql);
    await assertPendingFollowRejected(sql);
    await assertUndoneFollowRejected(sql);
    await assertPersonalRecipientIsolation(sql);
    await assertTriggerValidInsert(sql);
    await assertTriggerCrossProjectInsertRejected(sql);
    await assertTriggerCrossProjectUpdateRejected(sql);
    await assertTriggerUndoneFollowRejected(sql);
    console.log('activitypub federated report repository DB tests passed');
  } finally {
    await cleanupFixture(sql);
    await sql.end({ timeout: 5 });
  }
}

async function cleanupFixture(sql: postgres.Sql) {
  await sql`DELETE FROM public.federated_reports WHERE project_id IN (${fixtureProjectId}::uuid, ${secondaryProjectId}::uuid)`;
  await sql`DELETE FROM public.activitypub_activities WHERE actor_uri = ${remoteActorUri}`;
  await sql`DELETE FROM public.activitypub_follows WHERE local_actor_id IN (${localActorId}::uuid, ${secondaryActorId}::uuid)`;
  await sql`DELETE FROM public.activitypub_actors WHERE id IN (${localActorId}::uuid, ${secondaryActorId}::uuid)`;
  await sql`DELETE FROM public.projects WHERE id IN (${fixtureProjectId}::uuid, ${secondaryProjectId}::uuid)`;
}

async function seedFixture(sql: postgres.Sql) {
  for (const [id, slug, graphName] of [
    [fixtureProjectId, fixtureProjectSlug, 'graph_activitypub_report_db_fixture'],
    [secondaryProjectId, secondaryProjectSlug, 'graph_activitypub_report_db_fixture_b'],
  ] as const) {
    await sql`
      INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
      VALUES (${id}::uuid, ${slug}, ${slug}, ${graphName}, ${slug}, 'public')
    `;
  }
  for (const [id, slug, projectId] of [
    [localActorId, fixtureProjectSlug, fixtureProjectId],
    [secondaryActorId, secondaryProjectSlug, secondaryProjectId],
  ] as const) {
    await sql`
      INSERT INTO public.activitypub_actors (
        id, project_id, kind, preferred_username, display_name, enabled, public_key_pem, encrypted_private_key
      ) VALUES (
        ${id}::uuid,
        ${projectId}::uuid,
        'project',
        ${slug},
        ${slug},
        true,
        '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2\n4vl4Z2TLpqbb5CHmpSMgAS5KdEcTRL+RscJ0dHqN0NvdWT7qfB8xtB2LBvOkvUs\n7Y8YkPeDlaPk9N6pRSZ0WQgWwgQnR5UwP09NuoGfeDmGg8A32gs2WnLvvHQgkPw\nIDAQAB\n-----END PUBLIC KEY-----',
        '{"version":1,"algorithm":"aes-256-gcm","iv":"aXY=","ciphertext":"YQ==","tag":"dGFn"}'::jsonb
      )
    `;
    await sql`
      INSERT INTO public.activitypub_follows (
        id, direction, local_actor_id, remote_actor_uri, remote_inbox_uri, follow_activity_uri, status, accepted_at
      ) VALUES (
        gen_random_uuid(),
        'outbound',
        ${id}::uuid,
        ${remoteActorUri},
        ${remoteInboxUri},
        ${`https://lens.test/activitypub/activities/follow/${slug}`},
        'accepted',
        now()
      )
    `;
  }
}

function mappedInput(input: {
  activityUri: string;
  activityType: 'Create' | 'Announce';
  objectUri: string;
  sourceActorUri?: string;
}) {
  const sourceActorUri = input.sourceActorUri ?? remoteActorUri;
  return {
    activityUri: input.activityUri,
    activityType: input.activityType,
    sourceActorUri,
    canonicalRemoteObjectUri: input.objectUri,
    objectType: 'article' as const,
    title: 'Inbound report',
    summaryHtmlSanitized: '<p>hello</p>',
    originalUrl: input.objectUri,
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    remoteUpdatedAt: null,
  };
}

async function assertPersonalThenSharedFanIn(sql: postgres.Sql) {
  const repository = createPostgresFederatedReportRepository({ sql });
  const objectUri = 'https://remote.example/articles/personal-shared?case=1';
  const activityUri = 'https://remote.example/activities/create/personal-shared';
  const first = await repository.saveInboundReport({
    activityUri,
    activityType: 'Create',
    objectType: 'article',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: fixtureProjectSlug,
    mapped: mappedInput({ activityUri, activityType: 'Create', objectUri }),
  });
  assert.equal(first.saved, true);
  const second = await repository.saveInboundReport({
    activityUri,
    activityType: 'Create',
    objectType: 'article',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: null,
    mapped: mappedInput({ activityUri, activityType: 'Create', objectUri }),
  });
  assert.equal(second.saved, true);
  const rows = await sql`
    SELECT project_id FROM public.federated_reports WHERE remote_object_uri = ${objectUri}
  `;
  assert.equal(rows.length, 2);
}

async function assertCreateThenAnnounceSameObject(sql: postgres.Sql) {
  const repository = createPostgresFederatedReportRepository({ sql });
  const objectUri = 'https://remote.example/articles/create-then-announce?case=2';
  const createUri = 'https://remote.example/activities/create/order-2';
  const announceUri = 'https://remote.example/activities/announce/order-2';
  await repository.saveInboundReport({
    activityUri: createUri,
    activityType: 'Create',
    objectType: 'article',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: fixtureProjectSlug,
    mapped: mappedInput({ activityUri: createUri, activityType: 'Create', objectUri }),
  });
  const announce = await repository.saveInboundReport({
    activityUri: announceUri,
    activityType: 'Announce',
    objectType: 'article',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: fixtureProjectSlug,
    mapped: mappedInput({ activityUri: announceUri, activityType: 'Announce', objectUri }),
  });
  assert.equal(announce.saved, false);
  const rows = await sql`
    SELECT remote_activity_uri FROM public.federated_reports WHERE remote_object_uri = ${objectUri}
  `;
  assert.equal(rows.length, 1);
}

async function assertAnnounceThenCreateSameObject(sql: postgres.Sql) {
  const repository = createPostgresFederatedReportRepository({ sql });
  const objectUri = 'https://remote.example/articles/announce-then-create?case=3';
  const announceUri = 'https://remote.example/activities/announce/order-3';
  const createUri = 'https://remote.example/activities/create/order-3';
  await repository.saveInboundReport({
    activityUri: announceUri,
    activityType: 'Announce',
    objectType: 'article',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: fixtureProjectSlug,
    mapped: mappedInput({ activityUri: announceUri, activityType: 'Announce', objectUri }),
  });
  const create = await repository.saveInboundReport({
    activityUri: createUri,
    activityType: 'Create',
    objectType: 'article',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: fixtureProjectSlug,
    mapped: mappedInput({ activityUri: createUri, activityType: 'Create', objectUri }),
  });
  assert.equal(create.saved, false);
  const rows = await sql`
    SELECT remote_activity_uri FROM public.federated_reports WHERE remote_object_uri = ${objectUri}
  `;
  assert.equal(rows.length, 1);
}

async function assertActivityUriSpoofRejected(sql: postgres.Sql) {
  const repository = createPostgresFederatedReportRepository({ sql });
  const activityUri = 'https://remote.example/activities/create/personal-shared';
  const spoof = await repository.saveInboundReport({
    activityUri,
    activityType: 'Announce',
    objectType: 'article',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: fixtureProjectSlug,
    mapped: mappedInput({
      activityUri: 'https://remote.example/activities/announce/spoof',
      activityType: 'Announce',
      objectUri: 'https://remote.example/articles/spoof?case=4',
    }),
  });
  assert.equal(spoof.saved, false);
}

async function assertPendingFollowRejected(sql: postgres.Sql) {
  const repository = createPostgresFederatedReportRepository({ sql });
  const pendingFollowId = randomUUID();
  await sql`
    INSERT INTO public.activitypub_follows (
      id, direction, local_actor_id, remote_actor_uri, remote_inbox_uri, follow_activity_uri, status
    ) VALUES (
      ${pendingFollowId}::uuid,
      'outbound',
      ${localActorId}::uuid,
      ${pendingRemoteActorUri},
      ${pendingRemoteInboxUri},
      'https://lens.test/activitypub/activities/follow/pending-bob',
      'pending'
    )
  `;
  await assert.rejects(
    () =>
      sql`
        INSERT INTO public.federated_reports (
          id, project_id, source_follow_id, remote_object_uri, remote_activity_uri, remote_actor_uri,
          object_type, title, summary_html_sanitized, original_url, received_at
        ) VALUES (
          ${randomUUID()}::uuid,
          ${fixtureProjectId}::uuid,
          ${pendingFollowId}::uuid,
          'https://remote.example/articles/pending?case=5',
          'https://remote.example/activities/create/pending',
          ${pendingRemoteActorUri},
          'article',
          'title',
          '<p>hello</p>',
          'https://remote.example/articles/pending?case=5',
          now()
        )
      `,
    /invalid federated report follow binding/i,
  );
  const saved = await repository.saveInboundReport({
    activityUri: 'https://remote.example/activities/create/pending-repo',
    activityType: 'Create',
    objectType: 'article',
    sourceActorUri: pendingRemoteActorUri,
    recipientPreferredUsername: fixtureProjectSlug,
    mapped: mappedInput({
      activityUri: 'https://remote.example/activities/create/pending-repo',
      activityType: 'Create',
      objectUri: 'https://remote.example/articles/pending-repo?case=5b',
      sourceActorUri: pendingRemoteActorUri,
    }),
  });
  assert.equal(saved.saved, false);
}

async function assertUndoneFollowRejected(sql: postgres.Sql) {
  const repository = createPostgresFederatedReportRepository({ sql });
  const undoneFollowId = randomUUID();
  await sql`
    INSERT INTO public.activitypub_follows (
      id, direction, local_actor_id, remote_actor_uri, remote_inbox_uri, follow_activity_uri, status, accepted_at, undone_at
    ) VALUES (
      ${undoneFollowId}::uuid,
      'outbound',
      ${localActorId}::uuid,
      ${undoneRemoteActorUri},
      ${undoneRemoteInboxUri},
      'https://lens.test/activitypub/activities/follow/undone-carol',
      'undone',
      NULL,
      now()
    )
  `;
  await assert.rejects(
    () =>
      sql`
        INSERT INTO public.federated_reports (
          id, project_id, source_follow_id, remote_object_uri, remote_activity_uri, remote_actor_uri,
          object_type, title, summary_html_sanitized, original_url, received_at
        ) VALUES (
          ${randomUUID()}::uuid,
          ${fixtureProjectId}::uuid,
          ${undoneFollowId}::uuid,
          'https://remote.example/articles/undone?case=6',
          'https://remote.example/activities/create/undone',
          ${undoneRemoteActorUri},
          'article',
          'title',
          '<p>hello</p>',
          'https://remote.example/articles/undone?case=6',
          now()
        )
      `,
    /invalid federated report follow binding/i,
  );
  const saved = await repository.saveInboundReport({
    activityUri: 'https://remote.example/activities/create/undone-repo',
    activityType: 'Create',
    objectType: 'article',
    sourceActorUri: undoneRemoteActorUri,
    recipientPreferredUsername: fixtureProjectSlug,
    mapped: mappedInput({
      activityUri: 'https://remote.example/activities/create/undone-repo',
      activityType: 'Create',
      objectUri: 'https://remote.example/articles/undone-repo?case=6b',
      sourceActorUri: undoneRemoteActorUri,
    }),
  });
  assert.equal(saved.saved, false);
}

async function assertPersonalRecipientIsolation(sql: postgres.Sql) {
  const repository = createPostgresFederatedReportRepository({ sql });
  const objectUri = 'https://remote.example/articles/personal-only?case=7';
  const activityUri = 'https://remote.example/activities/create/personal-only';
  const saved = await repository.saveInboundReport({
    activityUri,
    activityType: 'Create',
    objectType: 'article',
    sourceActorUri: remoteActorUri,
    recipientPreferredUsername: fixtureProjectSlug,
    mapped: mappedInput({ activityUri, activityType: 'Create', objectUri }),
  });
  assert.equal(saved.saved, true);
  const rows = await sql`
    SELECT project_id FROM public.federated_reports WHERE remote_object_uri = ${objectUri}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.project_id, fixtureProjectId);
}

async function loadAcceptedFollowId(sql: postgres.Sql, actorId: string): Promise<string> {
  const rows = await sql`
    SELECT id FROM public.activitypub_follows
    WHERE local_actor_id = ${actorId}::uuid AND status = 'accepted' AND undone_at IS NULL
    LIMIT 1
  `;
  const followId = rows[0]?.id;
  assert.ok(typeof followId === 'string');
  return followId;
}

async function assertTriggerValidInsert(sql: postgres.Sql) {
  const followId = await loadAcceptedFollowId(sql, localActorId);
  const reportId = randomUUID();
  await sql`
    INSERT INTO public.federated_reports (
      id, project_id, source_follow_id, remote_object_uri, remote_activity_uri, remote_actor_uri,
      object_type, title, summary_html_sanitized, original_url, received_at
    ) VALUES (
      ${reportId}::uuid,
      ${fixtureProjectId}::uuid,
      ${followId}::uuid,
      'https://remote.example/articles/trigger-valid?case=8',
      'https://remote.example/activities/create/trigger-valid',
      ${remoteActorUri},
      'article',
      'title',
      '<p>hello</p>',
      'https://remote.example/articles/trigger-valid?case=8',
      now()
    )
  `;
}

async function assertTriggerCrossProjectInsertRejected(sql: postgres.Sql) {
  const followId = await loadAcceptedFollowId(sql, localActorId);
  await assert.rejects(
    () =>
      sql`
        INSERT INTO public.federated_reports (
          id, project_id, source_follow_id, remote_object_uri, remote_activity_uri, remote_actor_uri,
          object_type, title, summary_html_sanitized, original_url, received_at
        ) VALUES (
          ${randomUUID()}::uuid,
          ${secondaryProjectId}::uuid,
          ${followId}::uuid,
          'https://remote.example/articles/trigger-cross-insert?case=9',
          'https://remote.example/activities/create/trigger-cross-insert',
          ${remoteActorUri},
          'article',
          'title',
          '<p>hello</p>',
          'https://remote.example/articles/trigger-cross-insert?case=9',
          now()
        )
      `,
    /invalid federated report follow binding/i,
  );
}

async function assertTriggerCrossProjectUpdateRejected(sql: postgres.Sql) {
  const fixtureFollowId = await loadAcceptedFollowId(sql, localActorId);
  const secondaryFollowId = await loadAcceptedFollowId(sql, secondaryActorId);
  const reportId = randomUUID();
  const objectUri = 'https://remote.example/articles/trigger-update?case=10';
  await sql`
    INSERT INTO public.federated_reports (
      id, project_id, source_follow_id, remote_object_uri, remote_activity_uri, remote_actor_uri,
      object_type, title, summary_html_sanitized, original_url, received_at
    ) VALUES (
      ${reportId}::uuid,
      ${fixtureProjectId}::uuid,
      ${fixtureFollowId}::uuid,
      ${objectUri},
      'https://remote.example/activities/create/trigger-update',
      ${remoteActorUri},
      'article',
      'title',
      '<p>hello</p>',
      ${objectUri},
      now()
    )
  `;
  await assert.rejects(
    () =>
      sql`
        UPDATE public.federated_reports
        SET project_id = ${secondaryProjectId}::uuid,
            source_follow_id = ${secondaryFollowId}::uuid
        WHERE id = ${reportId}::uuid
      `,
    /invalid federated report follow binding/i,
  );
  const rows = await sql`
    SELECT project_id, source_follow_id
    FROM public.federated_reports
    WHERE id = ${reportId}::uuid
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.project_id, fixtureProjectId);
  assert.equal(rows[0]?.source_follow_id, fixtureFollowId);
}

async function assertTriggerUndoneFollowRejected(sql: postgres.Sql) {
  const undoneFollowId = randomUUID();
  await sql`
    INSERT INTO public.activitypub_follows (
      id, direction, local_actor_id, remote_actor_uri, remote_inbox_uri, follow_activity_uri, status, accepted_at, undone_at
    ) VALUES (
      ${undoneFollowId}::uuid,
      'outbound',
      ${secondaryActorId}::uuid,
      ${undoneTriggerRemoteActorUri},
      ${undoneTriggerRemoteInboxUri},
      'https://lens.test/activitypub/activities/follow/undone-trigger-dave',
      'undone',
      NULL,
      now()
    )
  `;
  await assert.rejects(
    () =>
      sql`
        INSERT INTO public.federated_reports (
          id, project_id, source_follow_id, remote_object_uri, remote_activity_uri, remote_actor_uri,
          object_type, title, summary_html_sanitized, original_url, received_at
        ) VALUES (
          ${randomUUID()}::uuid,
          ${secondaryProjectId}::uuid,
          ${undoneFollowId}::uuid,
          'https://remote.example/articles/trigger-undone?case=11',
          'https://remote.example/activities/create/trigger-undone',
          ${undoneTriggerRemoteActorUri},
          'article',
          'title',
          '<p>hello</p>',
          'https://remote.example/articles/trigger-undone?case=11',
          now()
        )
      `,
    /invalid federated report follow binding/i,
  );
}
