import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  discardRetryExhaustedActivityPubQueueMessage,
  fetchActivityPubOperationsSnapshot,
  inspectActivityPubQueueMessage,
  requeueRetryExhaustedActivityPubQueueMessage,
} from './operations.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!runDbTests) {
  console.log('Skipping ActivityPub operations DB tests (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for ActivityPub operations DB tests.');
}

const resolvedDatabaseUrl: string = databaseUrl;
const fixturePrefix = 'activitypub-operations-db';

await main();

async function main() {
  const sql = postgres(resolvedDatabaseUrl, { max: 1 });
  const messageId = randomUUID();
  const dedupeKey = `${fixturePrefix}:${messageId}`;

  try {
    await sql`
      DELETE FROM public.activitypub_queue_operator_actions
      WHERE queue_message_id = ${messageId}::uuid
    `;
    await sql`
      DELETE FROM public.activitypub_queue_messages
      WHERE id = ${messageId}::uuid
    `;

    await sql`
      INSERT INTO public.activitypub_queue_messages (
        id,
        dedupe_key,
        queue_kind,
        ordering_key,
        recipient_origin,
        message_json,
        status,
        attempt_count,
        last_error_code,
        last_http_status
      )
      VALUES (
        ${messageId}::uuid,
        ${dedupeKey},
        'outbox',
        ${`${fixturePrefix}:ordering`},
        'https://remote.example',
        '{"type":"Create"}'::jsonb,
        'retry_exhausted',
        3,
        'http_429',
        429
      )
    `;

    const inspected = await inspectActivityPubQueueMessage(sql, messageId);
    assert.ok(inspected);
    assert.equal(inspected.status, 'retry_exhausted');
    assert.equal(inspected.attemptCount, 3);
    assert.equal(Object.hasOwn(inspected as object, 'messageJson'), false);

    const snapshot = await fetchActivityPubOperationsSnapshot(sql);
    assert.ok(snapshot.retryExhaustedCurrentCount >= 1);
    assert.ok(snapshot.totalBusinessTableBytes >= 0);

    const requeued = await requeueRetryExhaustedActivityPubQueueMessage(sql, {
      messageId,
      expectedUpdatedAt: inspected.updatedAt,
      changeRef: 'ticket-ops-db-requeue',
    });
    assert.equal(requeued.status, 'updated');
    if (requeued.status !== 'updated') {
      throw new Error('Expected requeue to succeed.');
    }
    assert.equal(requeued.message.status, 'pending');
    assert.equal(requeued.message.attemptCount, 0);

    await sql`
      UPDATE public.activitypub_queue_messages
      SET
        status = 'retry_exhausted',
        attempt_count = 2,
        last_error_code = 'http_429',
        last_http_status = 429,
        updated_at = now()
      WHERE id = ${messageId}::uuid
    `;
    const retryExhaustedAgain = await inspectActivityPubQueueMessage(sql, messageId);
    assert.ok(retryExhaustedAgain);

    const stale = await discardRetryExhaustedActivityPubQueueMessage(sql, {
      messageId,
      expectedUpdatedAt: inspected.updatedAt,
      changeRef: 'ticket-ops-db-stale',
    });
    assert.equal(stale.status, 'stale_state');

    const discarded = await discardRetryExhaustedActivityPubQueueMessage(sql, {
      messageId,
      expectedUpdatedAt: retryExhaustedAgain.updatedAt,
      changeRef: 'ticket-ops-db-discard',
    });
    assert.equal(discarded.status, 'updated');
    if (discarded.status !== 'updated') {
      throw new Error('Expected discard to succeed.');
    }
    assert.equal(discarded.message.status, 'permanent_failure');
    assert.equal(discarded.message.lastErrorCode, 'http_429');

    const auditRows = await sql`
      SELECT action, change_ref
      FROM public.activitypub_queue_operator_actions
      WHERE queue_message_id = ${messageId}::uuid
      ORDER BY created_at ASC
    `;
    assert.equal(auditRows.length, 2);
    assert.equal(auditRows[0]?.action, 'requeue');
    assert.equal(auditRows[1]?.action, 'discard');

    let auditConstraintRejected = false;
    try {
      await sql`
        INSERT INTO public.activitypub_queue_operator_actions (
          queue_message_id,
          action,
          previous_status,
          new_status,
          previous_attempt_count,
          change_ref
        )
        VALUES (
          ${messageId}::uuid,
          'requeue',
          'pending',
          'pending',
          1,
          'ticket-invalid-transition'
        )
      `;
    } catch {
      auditConstraintRejected = true;
    }
    assert.equal(auditConstraintRejected, true);

    let invalidChangeRefRejected = false;
    try {
      await sql`
        INSERT INTO public.activitypub_queue_operator_actions (
          queue_message_id,
          action,
          previous_status,
          new_status,
          previous_attempt_count,
          change_ref
        )
        VALUES (
          ${messageId}::uuid,
          'discard',
          'retry_exhausted',
          'permanent_failure',
          1,
          'ops-db-invalid-ref'
        )
      `;
    } catch {
      invalidChangeRefRejected = true;
    }
    assert.equal(invalidChangeRefRejected, true);

    console.log('ActivityPub operations DB tests passed');
  } finally {
    await sql`
      DELETE FROM public.activitypub_queue_operator_actions
      WHERE queue_message_id = ${messageId}::uuid
    `;
    await sql`
      DELETE FROM public.activitypub_queue_messages
      WHERE id = ${messageId}::uuid
    `;
    await sql.end({ timeout: 5 });
  }
}
