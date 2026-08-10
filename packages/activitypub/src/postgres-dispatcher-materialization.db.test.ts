import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { DELIVERY_ERROR_CODES } from './delivery-errors.ts';
import { DISPATCHER_MAX_ATTEMPTS } from './dispatcher.ts';
import { failActivityMaterialization } from './postgres-dispatcher.ts';
import { parseActivityPubActivityRow } from './schema.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!runDbTests) {
  console.log('Skipping materialization failure DB tests (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for materialization failure DB tests.');
}

const resolvedDatabaseUrl: string = databaseUrl;
const activityId = '4f000000-0000-0000-0000-00000000db41';
const projectId = '4f000000-0000-0000-0000-00000000db43';
const projectActorId = '4f000000-0000-0000-0000-00000000db42';
const projectSlug = 'activitypub-materialization-failure-fixture';
const baseTime = new Date('2026-01-15T12:00:00.000Z');
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
    await seedFixture(sql);
    await assertTransientRetryReschedulesPending(sql);
    await assertRetryExhaustedMarksFailed(sql);
    await assertLeaseLostDoesNotOverwrite(sql);
    console.log('activitypub materialization failure DB tests passed');
  } finally {
    await cleanup(sql);
    await sql.end({ timeout: 5 });
  }
}

async function cleanup(sql: postgres.Sql) {
  await sql`
    DELETE FROM public.activitypub_activities
    WHERE id = ${activityId}::uuid
      OR local_actor_id = ${projectActorId}::uuid
  `;
  await sql`DELETE FROM public.activitypub_actors WHERE id = ${projectActorId}::uuid`;
  await sql`DELETE FROM public.projects WHERE id = ${projectId}::uuid`;
}

async function seedFixture(sql: postgres.Sql) {
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${projectId}::uuid,
      ${projectSlug},
      'Materialization Failure Fixture',
      'graph_activitypub_materialization_failure_fixture',
      ${projectSlug},
      'public'
    )
  `;
  await sql`
    INSERT INTO public.activitypub_actors (
      id, project_id, kind, preferred_username, display_name, enabled, public_key_pem, encrypted_private_key
    )
    VALUES (
      ${projectActorId}::uuid,
      ${projectId}::uuid,
      'project',
      ${projectSlug},
      'Materialization Failure Fixture',
      true,
      '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2\n4vl4Z2TLpqbb5CHmpSMgAS5KdEcTRL+RscJ0dHqN0NvdWT7qfB8xtB2LBvOkvUs\n7Y8YkPeDlaPk9N6pRSZ0WQgWwgQnR5UwP09NuoGfeDmGg8A32gs2WnLvvHQgkPw\nIDAQAB\n-----END PUBLIC KEY-----',
      ${sql.json(encryptedPrivateKey as never)}
    )
  `;
  await sql`
    INSERT INTO public.activitypub_activities (
      id,
      activity_uri,
      object_uri,
      activity_type,
      actor_uri,
      local_actor_id,
      direction,
      payload_json,
      processing_status,
      available_at,
      occurred_at,
      attempt_count
    )
    VALUES (
      ${activityId}::uuid,
      ${`https://lens.test/activitypub/activities/create/${activityId}`},
      ${`https://lens.test/activitypub/reports/${activityId}`},
      'Create',
      ${`https://lens.test/activitypub/actors/${projectSlug}`},
      ${projectActorId}::uuid,
      'outbound',
      ${sql.json({
        schemaVersion: 1,
        reportId: '00000000-0000-0000-0000-000000000099',
        objectRepresentation: 'article',
        projectSlug,
      } as never)},
      'pending',
      ${baseTime},
      ${baseTime},
      0
    )
  `;
}

async function claimActivity(sql: postgres.Sql, attemptCount: number) {
  const workerToken = randomUUID();
  const leaseExpiresAt = new Date(baseTime.getTime() + 15 * 60 * 1000);
  await sql`
    UPDATE public.activitypub_activities
    SET processing_status = 'running',
        worker_token = ${workerToken},
        lease_expires_at = ${leaseExpiresAt},
        attempt_count = ${attemptCount}
    WHERE id = ${activityId}::uuid
  `;
  const rows =
    await sql`SELECT * FROM public.activitypub_activities WHERE id = ${activityId}::uuid`;
  return {
    id: activityId,
    workerToken,
    attemptCount,
    activity: parseActivityPubActivityRow(rows[0]),
  };
}

async function assertTransientRetryReschedulesPending(sql: postgres.Sql) {
  const claimed = await claimActivity(sql, 1);
  const clock = { now: () => baseTime };
  await failActivityMaterialization({
    sql,
    clock,
    claimed,
    error: new Error('transient'),
  });
  const row = await sql`
    SELECT processing_status, attempt_count, worker_token, lease_expires_at, last_error_code, available_at
    FROM public.activitypub_activities
    WHERE id = ${activityId}::uuid
  `;
  assert.equal(row[0]?.processing_status, 'pending');
  assert.equal(row[0]?.worker_token, null);
  assert.equal(row[0]?.lease_expires_at, null);
  assert.equal(row[0]?.last_error_code, DELIVERY_ERROR_CODES.unknownDeliveryError);
  const availableAt = row[0]?.available_at;
  assert.ok(availableAt instanceof Date);
  assert.ok(availableAt.getTime() > baseTime.getTime());
}

async function assertRetryExhaustedMarksFailed(sql: postgres.Sql) {
  const claimed = await claimActivity(sql, DISPATCHER_MAX_ATTEMPTS);
  const clock = { now: () => baseTime };
  await failActivityMaterialization({
    sql,
    clock,
    claimed,
    error: new Error('transient'),
  });
  const row = await sql`
    SELECT processing_status, last_error_code
    FROM public.activitypub_activities
    WHERE id = ${activityId}::uuid
  `;
  assert.equal(row[0]?.processing_status, 'failed');
  assert.equal(row[0]?.last_error_code, DELIVERY_ERROR_CODES.materializationRetryExhausted);
}

async function assertLeaseLostDoesNotOverwrite(sql: postgres.Sql) {
  const workerToken = randomUUID();
  const expiredLease = new Date(baseTime.getTime() - 60_000);
  const availableAt = new Date(expiredLease.getTime() - 60_000);
  await sql`
    UPDATE public.activitypub_activities
    SET processing_status = 'running',
        worker_token = ${workerToken},
        lease_expires_at = ${expiredLease},
        available_at = ${availableAt},
        attempt_count = 2,
        last_error_code = 'previous_code'
    WHERE id = ${activityId}::uuid
  `;
  const rows =
    await sql`SELECT * FROM public.activitypub_activities WHERE id = ${activityId}::uuid`;
  const claimed = {
    id: activityId,
    workerToken,
    attemptCount: 2,
    activity: parseActivityPubActivityRow(rows[0]),
  };
  await failActivityMaterialization({
    sql,
    clock: { now: () => baseTime },
    claimed,
    error: new Error('transient'),
  });
  const row = await sql`
    SELECT processing_status, last_error_code, worker_token
    FROM public.activitypub_activities
    WHERE id = ${activityId}::uuid
  `;
  assert.equal(row[0]?.processing_status, 'running');
  assert.equal(row[0]?.last_error_code, 'previous_code');
  assert.equal(row[0]?.worker_token, workerToken);
}
