import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { exportJwk, generateCryptoKeyPair } from '@fedify/fedify';
import postgres from 'postgres';
import { createPostgresActivityPubRepository } from './actor-repository.ts';
import { DELIVERY_ERROR_CODES } from './delivery-errors.ts';
import { DISPATCHER_LEASE_MS } from './dispatcher.ts';
import { createFedifyOutboxMessageFixture } from './fedify-message-fixture.ts';
import { createPostgresQueueAdapter, processOneQueuedMessage } from './postgres.ts';
import { buildOutboxDedupeKey } from './queue.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!runDbTests) {
  console.log('Skipping postgres queue delivery DB tests (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for postgres queue delivery DB tests.');
}

const resolvedDatabaseUrl: string = databaseUrl;
const encryptionKey = Buffer.alloc(32, 44);
const canonicalOrigin = 'https://lens.test';
const fixtureProjectId = '4f000000-0000-0000-0000-00000000db41';
const fixtureProjectSlug = 'activitypub-queue-delivery-fixture';
let seededLocalActorId = '';
let seededKeyId = '';

const { privateKey } = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5');
const privateJwk = await exportJwk(privateKey);

await main();

async function main() {
  const sql = postgres(resolvedDatabaseUrl, { max: 1 });
  try {
    await cleanupFixture(sql);
    await seedFixture(sql);
    await assertPermanentFailureFor404DoesNotSucceed(sql);
    await assertRetryWaitFor503(sql);
    await assertRetryWaitHonorsRetryAfter(sql);
    await assertClaimFairnessSkipsBlockedOrderingRows(sql);
    await assertSuccessorBlockedUntilPredecessorSucceeds(sql);
    await assertTerminalPredecessorTerminalizesSuccessor(sql);
    await assertLeaseReclaimAllowsRetry(sql);
    console.log('activitypub postgres queue delivery DB tests passed');
  } finally {
    await cleanupFixture(sql);
    await sql.end({ timeout: 5 });
  }
}

async function cleanupFixture(sql: postgres.Sql) {
  await sql`DELETE FROM public.activitypub_queue_messages WHERE dedupe_key LIKE ${`${canonicalOrigin}%`}`;
  if (seededLocalActorId) {
    await sql`DELETE FROM public.activitypub_actors WHERE id = ${seededLocalActorId}::uuid`;
  }
  await sql`DELETE FROM public.projects WHERE id = ${fixtureProjectId}::uuid`;
  seededLocalActorId = '';
  seededKeyId = '';
}

async function seedFixture(sql: postgres.Sql) {
  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  await sql`
    INSERT INTO public.projects (id, slug, name, graph_name, storage_prefix, visibility)
    VALUES (
      ${fixtureProjectId}::uuid,
      ${fixtureProjectSlug},
      'Queue Delivery Fixture',
      'graph_activitypub_queue_delivery_fixture',
      ${fixtureProjectSlug},
      'public'
    )
  `;
  const actor = await actorRepository.enableProjectActor({
    projectId: fixtureProjectId,
    projectSlug: fixtureProjectSlug,
  });
  seededLocalActorId = actor.id;
  seededKeyId = `${canonicalOrigin}/activitypub/actors/${fixtureProjectSlug}#main-key`;
}

function createProcessInput(sql: postgres.Sql) {
  const actorRepository = createPostgresActivityPubRepository({ sql, encryptionKey });
  return {
    sql,
    canonicalOrigin,
    encryptionKey,
    actorRepository,
    testOnlyAllowPrivateAddress: true,
    preferredQueueKind: 'outbox' as const,
  };
}

async function enqueueOutboxTo(
  sql: postgres.Sql,
  inboxUrl: string,
  suffix: string,
  orderingKey?: string,
) {
  const activityId = `${canonicalOrigin}/activitypub/activities/create/${suffix}`;
  const queue = createPostgresQueueAdapter({ sql, canonicalOrigin });
  const message = createFedifyOutboxMessageFixture({
    baseUrl: canonicalOrigin,
    inbox: inboxUrl,
    activityId,
    orderingKey: orderingKey ?? `${canonicalOrigin}/activitypub/reports/${suffix}`,
    reportId: suffix,
    projectSlug: fixtureProjectSlug,
    actorPath: fixtureProjectSlug,
    keys: [{ keyId: seededKeyId, privateKey: privateJwk }],
  });
  const dedupeKey = buildOutboxDedupeKey({ activityId, recipientInbox: inboxUrl });
  await queue.enqueue(message, { dedupeKey, orderingKey: message.orderingKey });
  return { activityId, dedupeKey };
}

async function assertPermanentFailureFor404DoesNotSucceed(sql: postgres.Sql) {
  const fixture = await startFixtureServer(404);
  try {
    const { dedupeKey } = await enqueueOutboxTo(sql, fixture.inboxUrl, 'queue-delivery-404');
    const result = await processOneQueuedMessage(createProcessInput(sql));
    assert.equal(result.status, 'delivery_failed');
    const row = await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status, last_error_code
      FROM public.activitypub_queue_messages
      WHERE dedupe_key = ${dedupeKey}
    `;
    assert.equal(row[0]?.status, 'permanent_failure');
    assert.equal(row[0]?.last_error_code, DELIVERY_ERROR_CODES.inboxGone);
  } finally {
    await fixture.close();
  }
}

async function assertRetryWaitFor503(sql: postgres.Sql) {
  const fixture = await startFixtureServer(503);
  try {
    const { dedupeKey } = await enqueueOutboxTo(sql, fixture.inboxUrl, 'queue-delivery-503');
    const result = await processOneQueuedMessage(createProcessInput(sql));
    assert.equal(result.status, 'delivery_failed');
    const row = await sql<{ status: string; last_error_code: string | null }[]>`
      SELECT status, last_error_code
      FROM public.activitypub_queue_messages
      WHERE dedupe_key = ${dedupeKey}
    `;
    assert.equal(row[0]?.status, 'retry_wait');
    assert.equal(row[0]?.last_error_code, DELIVERY_ERROR_CODES.http5xx);
  } finally {
    await fixture.close();
  }
}

async function assertRetryWaitHonorsRetryAfter(sql: postgres.Sql) {
  const fixture = await startFixtureServer(429, { 'retry-after': '120' });
  try {
    const { dedupeKey } = await enqueueOutboxTo(sql, fixture.inboxUrl, 'queue-delivery-429');
    const result = await processOneQueuedMessage(createProcessInput(sql));
    assert.equal(result.status, 'delivery_failed');
    const row = await sql<{ status: string; last_error_code: string | null; available_at: Date }[]>`
      SELECT status, last_error_code, available_at
      FROM public.activitypub_queue_messages
      WHERE dedupe_key = ${dedupeKey}
    `;
    assert.equal(row[0]?.status, 'retry_wait');
    assert.equal(row[0]?.last_error_code, DELIVERY_ERROR_CODES.http429);
    assert.ok(row[0]?.available_at.getTime() > Date.now() + 30_000);
  } finally {
    await fixture.close();
  }
}

async function assertClaimFairnessSkipsBlockedOrderingRows(sql: postgres.Sql) {
  const fixture = await startFixtureServer(202);
  try {
    const orderingKey = `${canonicalOrigin}/activitypub/reports/queue-fairness`;
    const recipientOrigin = 'https://blocked.example';
    const blockedInbox = `${recipientOrigin}/inbox`;
    const predecessorId = randomUUID();
    await sql`
      INSERT INTO public.activitypub_queue_messages (
        id, dedupe_key, queue_kind, ordering_key, recipient_origin, message_json, status,
        available_at, attempt_count, created_at, updated_at, started_at
      )
      VALUES (
        ${predecessorId},
        ${`${canonicalOrigin}/predecessor|${blockedInbox}`},
        'outbox',
        ${orderingKey},
        ${recipientOrigin},
        ${sql.json({ type: 'outbox', placeholder: true })},
        'running',
        now(),
        1,
        now() - interval '2 hours',
        now(),
        now()
      )
    `;
    for (let index = 0; index < 25; index += 1) {
      await sql`
        INSERT INTO public.activitypub_queue_messages (
          id, dedupe_key, queue_kind, ordering_key, recipient_origin, message_json, status,
          available_at, attempt_count, created_at, updated_at
        )
        VALUES (
          ${randomUUID()},
          ${`${canonicalOrigin}/blocked-${index}|${blockedInbox}`},
          'outbox',
          ${orderingKey},
          ${recipientOrigin},
          ${sql.json({ type: 'outbox', placeholder: true })},
          'pending',
          now(),
          0,
          now() - interval '1 hour',
          now()
        )
      `;
    }
    const { dedupeKey } = await enqueueOutboxTo(
      sql,
      fixture.inboxUrl,
      'queue-fairness-claimable',
      `${canonicalOrigin}/activitypub/reports/other`,
    );
    const result = await processOneQueuedMessage(createProcessInput(sql));
    assert.equal(result.status, 'processed');
    const claimed = await sql<{ status: string }[]>`
      SELECT status
      FROM public.activitypub_queue_messages
      WHERE dedupe_key = ${dedupeKey}
    `;
    assert.equal(claimed[0]?.status, 'succeeded');
  } finally {
    await fixture.close();
  }
}

async function assertSuccessorBlockedUntilPredecessorSucceeds(sql: postgres.Sql) {
  const fixture = await startFixtureServer(202);
  try {
    const orderingKey = `${canonicalOrigin}/activitypub/reports/queue-ordering`;
    const predecessorDedupe = await enqueueOutboxTo(
      sql,
      fixture.inboxUrl,
      'ordering-predecessor',
      orderingKey,
    );
    const successor = await enqueueOutboxTo(
      sql,
      fixture.inboxUrl,
      'ordering-successor',
      orderingKey,
    );
    const first = await processOneQueuedMessage(createProcessInput(sql));
    assert.equal(first.status, 'processed');
    const predecessor = await sql<{ status: string }[]>`
      SELECT status FROM public.activitypub_queue_messages WHERE dedupe_key = ${predecessorDedupe.dedupeKey}
    `;
    assert.equal(predecessor[0]?.status, 'succeeded');
    const blockedSuccessor = await sql<{ status: string }[]>`
      SELECT status FROM public.activitypub_queue_messages WHERE dedupe_key = ${successor.dedupeKey}
    `;
    assert.equal(blockedSuccessor[0]?.status, 'pending');
    const second = await processOneQueuedMessage(createProcessInput(sql));
    assert.equal(second.status, 'processed');
    const successorRow = await sql<{ status: string }[]>`
      SELECT status FROM public.activitypub_queue_messages WHERE dedupe_key = ${successor.dedupeKey}
    `;
    assert.equal(successorRow[0]?.status, 'succeeded');
  } finally {
    await fixture.close();
  }
}

async function assertTerminalPredecessorTerminalizesSuccessor(sql: postgres.Sql) {
  const orderingKey = `${canonicalOrigin}/activitypub/reports/queue-terminal`;
  const recipientOrigin = 'https://terminal.example';
  const inboxUrl = `${recipientOrigin}/inbox`;
  const predecessorId = randomUUID();
  await sql`
    INSERT INTO public.activitypub_queue_messages (
      id, dedupe_key, queue_kind, ordering_key, recipient_origin, message_json, status,
      available_at, attempt_count, created_at, updated_at, completed_at, last_error_code
    )
    VALUES (
      ${predecessorId},
      ${`${canonicalOrigin}/terminal-predecessor|${inboxUrl}`},
      'outbox',
      ${orderingKey},
      ${recipientOrigin},
      ${sql.json({ type: 'outbox', placeholder: true })},
      'permanent_failure',
      now(),
      1,
      now() - interval '2 hours',
      now(),
      now(),
      ${DELIVERY_ERROR_CODES.inboxGone}
    )
  `;
  const successor = await enqueueOutboxTo(sql, inboxUrl, 'queue-terminal-successor', orderingKey);
  const result = await processOneQueuedMessage(createProcessInput(sql));
  assert.equal(result.status, 'no-op');
  const successorRow = await sql<{ status: string; last_error_code: string | null }[]>`
    SELECT status, last_error_code
    FROM public.activitypub_queue_messages
    WHERE dedupe_key = ${successor.dedupeKey}
  `;
  assert.equal(successorRow[0]?.status, 'permanent_failure');
  assert.equal(successorRow[0]?.last_error_code, 'activitypub_predecessor_failure');
}

async function assertLeaseReclaimAllowsRetry(sql: postgres.Sql) {
  const fixture = await startFixtureServer(202);
  try {
    const orderingKey = `${canonicalOrigin}/activitypub/reports/queue-lease`;
    const { dedupeKey } = await enqueueOutboxTo(sql, fixture.inboxUrl, 'queue-lease', orderingKey);
    await sql`
      UPDATE public.activitypub_queue_messages
      SET status = 'running',
          worker_token = ${randomUUID()},
          lease_expires_at = ${new Date(Date.now() - 1_000)},
          attempt_lease_started_at = ${new Date(Date.now() - DISPATCHER_LEASE_MS)},
          attempt_count = 1
      WHERE dedupe_key = ${dedupeKey}
    `;
    const result = await processOneQueuedMessage(createProcessInput(sql));
    assert.equal(result.status, 'processed');
    const row = await sql<{ status: string }[]>`
      SELECT status FROM public.activitypub_queue_messages WHERE dedupe_key = ${dedupeKey}
    `;
    assert.equal(row[0]?.status, 'succeeded');
  } finally {
    await fixture.close();
  }
}

async function startFixtureServer(
  statusCode: number,
  extraHeaders: Record<string, string> = {},
): Promise<{ inboxUrl: string; close: () => Promise<void> }> {
  const server = createServer((request: IncomingMessage, response) => {
    for (const [name, value] of Object.entries(extraHeaders)) {
      response.setHeader(name, value);
    }
    response.statusCode = statusCode;
    response.end(statusCode >= 400 ? 'error' : 'accepted');
    request.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fixture server failed to bind');
  }
  return {
    inboxUrl: `http://127.0.0.1:${address.port}/inbox`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
