import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { DELIVERY_ERROR_CODES, isDeliveryErrorCode } from './delivery-errors.ts';

const runDbTests = process.env.ACTIVITYPUB_RUN_DB_TESTS === '1';
const databaseUrl = process.env.DATABASE_URL?.trim();
const migration0020Path = join(
  import.meta.dirname,
  '../../../infra/db/migrations/0020_activitypub_report_publication_outbox.sql',
);

class RollbackSentinelError extends Error {
  constructor() {
    super('ROLLBACK_SENTINEL');
    this.name = 'RollbackSentinelError';
  }
}

if (!runDbTests) {
  console.log('Skipping 0020 legacy error backfill DB test (run via pnpm test:db)');
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for 0020 legacy error backfill DB test.');
}

const resolvedDatabaseUrl: string = databaseUrl;
const queueMessageId = '4f000000-0000-0000-0000-00000000db51';
const activityId = '4f000000-0000-0000-0000-00000000db52';
const legacyErrorCode = 'activitypub_delivery_failed';

await main();

async function main() {
  const sql = postgres(resolvedDatabaseUrl, { max: 1 });
  const migrationSql = await readFile(migration0020Path, 'utf8');

  try {
    await assertLegacyErrorBackfillInTransaction(sql, migrationSql);
    console.log('activitypub 0020 legacy error backfill DB test passed');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function assertLegacyErrorBackfillInTransaction(
  sql: postgres.Sql,
  migrationSql: string,
): Promise<void> {
  try {
    await sql.begin(async (transaction) => {
      await transaction`
        ALTER TABLE public.activitypub_queue_messages
        DROP CONSTRAINT IF EXISTS activitypub_queue_messages_last_error_code_check
      `;
      await transaction`
        ALTER TABLE public.activitypub_activities
        DROP CONSTRAINT IF EXISTS activitypub_activities_last_error_code_check
      `;

      await transaction`
        INSERT INTO public.activitypub_queue_messages (
          id,
          dedupe_key,
          queue_kind,
          message_json,
          status,
          available_at,
          attempt_count,
          created_at,
          updated_at,
          last_error_code
        )
        VALUES (
          ${queueMessageId}::uuid,
          ${`https://lens.test/legacy-backfill/${queueMessageId}`},
          'inbox',
          ${transaction.json({ type: 'inbox', placeholder: true })},
          'permanent_failure',
          now(),
          1,
          now(),
          now(),
          ${legacyErrorCode}
        )
      `;

      await transaction`
        INSERT INTO public.activitypub_activities (
          id,
          activity_uri,
          activity_type,
          actor_uri,
          direction,
          payload_json,
          processing_status,
          available_at,
          occurred_at,
          last_error_code
        )
        VALUES (
          ${activityId}::uuid,
          ${`https://lens.test/activitypub/activities/legacy-backfill/${activityId}`},
          'Create',
          'https://remote.example/users/alice',
          'inbound',
          ${transaction.json({ type: 'Create' })},
          'failed',
          now(),
          now(),
          ${legacyErrorCode}
        )
      `;

      await transaction.unsafe(migrationSql);

      const queueRows = await transaction<{ last_error_code: string | null }[]>`
        SELECT last_error_code
        FROM public.activitypub_queue_messages
        WHERE id = ${queueMessageId}::uuid
      `;
      const activityRows = await transaction<{ last_error_code: string | null }[]>`
        SELECT last_error_code
        FROM public.activitypub_activities
        WHERE id = ${activityId}::uuid
      `;

      const queueErrorCode = queueRows[0]?.last_error_code;
      const activityErrorCode = activityRows[0]?.last_error_code;
      assert.equal(queueErrorCode, DELIVERY_ERROR_CODES.unknownDeliveryError);
      assert.equal(activityErrorCode, DELIVERY_ERROR_CODES.unknownDeliveryError);
      assert.equal(isDeliveryErrorCode(queueErrorCode), true);
      assert.equal(isDeliveryErrorCode(activityErrorCode), true);

      throw new RollbackSentinelError();
    });
  } catch (error) {
    if (error instanceof RollbackSentinelError) {
      return;
    }
    throw error;
  }
}
