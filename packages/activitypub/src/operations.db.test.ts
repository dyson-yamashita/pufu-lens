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
const APPEND_ONLY_ERROR = 'activitypub_queue_operator_actions rows are append-only';
const rollbackSentinel = Symbol('activitypub-operations-db-rollback');

type ActivityPubSql = Parameters<typeof inspectActivityPubQueueMessage>[0];

/**
 * Test-only Sql adapter for operator functions invoked inside a rollback fixture
 * transaction. Public operators call `sql.begin()`, which `TransactionSql` does not
 * expose; join those nested transactions into the outer fixture instead of starting
 * a new one so queue rows and append-only audit rows roll back together.
 */
function createJoinableOperatorSql(transaction: postgres.TransactionSql): ActivityPubSql {
  return new Proxy(transaction as unknown as ActivityPubSql, {
    apply(_target, _thisArg, args) {
      return Reflect.apply(
        transaction as unknown as (...args: Parameters<ActivityPubSql>) => unknown,
        transaction,
        args,
      );
    },
    get(target, property, receiver) {
      if (property === 'begin') {
        return async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
          callback(transaction);
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }

      return value;
    },
  });
}

await main();

async function main() {
  const sql = postgres(resolvedDatabaseUrl, { max: 1 });

  try {
    await sql.begin(async (transaction) => {
      const operatorSql = createJoinableOperatorSql(transaction);
      const messageId = randomUUID();
      const futureLeaseMessageId = randomUUID();
      const expiredLeaseMessageId = randomUUID();
      const pendingMessageId = randomUUID();
      const dedupeKey = `${fixturePrefix}:${messageId}`;

      await transaction`
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

      const inspected = await inspectActivityPubQueueMessage(operatorSql, messageId);
      assert.ok(inspected);
      assert.equal(inspected.status, 'retry_exhausted');
      assert.equal(inspected.attemptCount, 3);
      assert.equal(Object.hasOwn(inspected as object, 'messageJson'), false);

      const snapshot = await fetchActivityPubOperationsSnapshot(operatorSql);
      assert.ok(snapshot.retryExhaustedCurrentCount >= 1);
      assert.ok(snapshot.totalBusinessTableBytes >= 0);

      const requeued = await requeueRetryExhaustedActivityPubQueueMessage(operatorSql, {
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

      await transaction`
        UPDATE public.activitypub_queue_messages
        SET
          status = 'retry_exhausted',
          attempt_count = 2,
          last_error_code = 'http_429',
          last_http_status = 429,
          updated_at = updated_at + interval '1 second'
        WHERE id = ${messageId}::uuid
      `;
      const retryExhaustedAgain = await inspectActivityPubQueueMessage(operatorSql, messageId);
      assert.ok(retryExhaustedAgain);

      const stale = await discardRetryExhaustedActivityPubQueueMessage(operatorSql, {
        messageId,
        expectedUpdatedAt: inspected.updatedAt,
        changeRef: 'ticket-ops-db-stale',
      });
      assert.equal(stale.status, 'stale_state');

      const discarded = await discardRetryExhaustedActivityPubQueueMessage(operatorSql, {
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

      const auditRows = await transaction`
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
        await transaction.savepoint(async (savepoint) => {
          await savepoint`
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
        });
      } catch {
        auditConstraintRejected = true;
      }
      assert.equal(auditConstraintRejected, true);

      let invalidChangeRefRejected = false;
      try {
        await transaction.savepoint(async (savepoint) => {
          await savepoint`
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
        });
      } catch {
        invalidChangeRefRejected = true;
      }
      assert.equal(invalidChangeRefRejected, true);

      await transaction`
        INSERT INTO public.activitypub_queue_messages (
          id,
          dedupe_key,
          queue_kind,
          ordering_key,
          recipient_origin,
          message_json,
          status,
          attempt_count,
          worker_token,
          lease_expires_at
        )
        VALUES (
          ${futureLeaseMessageId}::uuid,
          ${`${fixturePrefix}:future-lease`},
          'outbox',
          ${`${fixturePrefix}:future-lease-ordering`},
          'https://future-lease.example',
          '{"type":"Create"}'::jsonb,
          'retry_exhausted',
          1,
          ${randomUUID()}::uuid,
          now() + interval '5 minutes'
        )
      `;
      const futureLeaseInspect = await inspectActivityPubQueueMessage(
        operatorSql,
        futureLeaseMessageId,
      );
      assert.ok(futureLeaseInspect);
      const futureLeaseMutation = await requeueRetryExhaustedActivityPubQueueMessage(operatorSql, {
        messageId: futureLeaseMessageId,
        expectedUpdatedAt: futureLeaseInspect.updatedAt,
        changeRef: 'ticket-ops-db-future-lease',
      });
      assert.equal(futureLeaseMutation.status, 'active_lease');
      const futureLeaseAuditCount = await transaction`
        SELECT COUNT(*)::int AS count
        FROM public.activitypub_queue_operator_actions
        WHERE queue_message_id = ${futureLeaseMessageId}::uuid
      `;
      assert.equal(futureLeaseAuditCount[0]?.count, 0);

      await transaction`
        INSERT INTO public.activitypub_queue_messages (
          id,
          dedupe_key,
          queue_kind,
          ordering_key,
          recipient_origin,
          message_json,
          status,
          attempt_count,
          worker_token,
          lease_expires_at
        )
        VALUES (
          ${expiredLeaseMessageId}::uuid,
          ${`${fixturePrefix}:expired-lease`},
          'outbox',
          ${`${fixturePrefix}:expired-lease-ordering`},
          'https://expired-lease.example',
          '{"type":"Create"}'::jsonb,
          'retry_exhausted',
          1,
          ${randomUUID()}::uuid,
          now() - interval '5 minutes'
        )
      `;
      const expiredLeaseInspect = await inspectActivityPubQueueMessage(
        operatorSql,
        expiredLeaseMessageId,
      );
      assert.ok(expiredLeaseInspect);
      const expiredLeaseMutation = await requeueRetryExhaustedActivityPubQueueMessage(operatorSql, {
        messageId: expiredLeaseMessageId,
        expectedUpdatedAt: expiredLeaseInspect.updatedAt,
        changeRef: 'ticket-ops-db-expired-lease',
      });
      assert.equal(expiredLeaseMutation.status, 'updated');
      if (expiredLeaseMutation.status !== 'updated') {
        throw new Error('Expected expired lease mutation to succeed.');
      }
      assert.equal(expiredLeaseMutation.message.status, 'pending');
      const expiredLeaseRow = await transaction`
        SELECT worker_token, lease_expires_at
        FROM public.activitypub_queue_messages
        WHERE id = ${expiredLeaseMessageId}::uuid
      `;
      assert.equal(expiredLeaseRow[0]?.worker_token, null);
      assert.equal(expiredLeaseRow[0]?.lease_expires_at, null);

      await transaction`
        INSERT INTO public.activitypub_queue_messages (
          id,
          dedupe_key,
          queue_kind,
          ordering_key,
          recipient_origin,
          message_json,
          status,
          attempt_count
        )
        VALUES (
          ${pendingMessageId}::uuid,
          ${`${fixturePrefix}:pending`},
          'outbox',
          ${`${fixturePrefix}:pending-ordering`},
          'https://pending.example',
          '{"type":"Create"}'::jsonb,
          'pending',
          0
        )
      `;
      const pendingInspect = await inspectActivityPubQueueMessage(operatorSql, pendingMessageId);
      assert.ok(pendingInspect);
      const pendingMutation = await discardRetryExhaustedActivityPubQueueMessage(operatorSql, {
        messageId: pendingMessageId,
        expectedUpdatedAt: pendingInspect.updatedAt,
        changeRef: 'ticket-ops-db-pending',
      });
      assert.equal(pendingMutation.status, 'invalid_status');
      if (pendingMutation.status === 'invalid_status') {
        assert.equal(pendingMutation.currentStatus, 'pending');
      }
      const pendingAuditCount = await transaction`
        SELECT COUNT(*)::int AS count
        FROM public.activitypub_queue_operator_actions
        WHERE queue_message_id = ${pendingMessageId}::uuid
      `;
      assert.equal(pendingAuditCount[0]?.count, 0);

      const auditRow = auditRows[0];
      assert.ok(auditRow);

      let updateRejected = false;
      try {
        await transaction.savepoint(async (savepoint) => {
          await savepoint`
            UPDATE public.activitypub_queue_operator_actions
            SET change_ref = 'ticket-ops-db-update'
            WHERE queue_message_id = ${messageId}::uuid
          `;
        });
      } catch (error) {
        updateRejected = error instanceof Error && error.message.includes(APPEND_ONLY_ERROR);
      }
      assert.equal(updateRejected, true);

      let deleteRejected = false;
      try {
        await transaction.savepoint(async (savepoint) => {
          await savepoint`
            DELETE FROM public.activitypub_queue_operator_actions
            WHERE queue_message_id = ${messageId}::uuid
          `;
        });
      } catch (error) {
        deleteRejected = error instanceof Error && error.message.includes(APPEND_ONLY_ERROR);
      }
      assert.equal(deleteRejected, true);

      const unchangedAuditRows = await transaction`
        SELECT action, change_ref
        FROM public.activitypub_queue_operator_actions
        WHERE queue_message_id = ${messageId}::uuid
        ORDER BY created_at ASC
      `;
      assert.deepEqual(unchangedAuditRows, auditRows);

      throw rollbackSentinel;
    });
  } catch (error) {
    if (error !== rollbackSentinel) {
      throw error;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  console.log('ActivityPub operations DB tests passed');
}
