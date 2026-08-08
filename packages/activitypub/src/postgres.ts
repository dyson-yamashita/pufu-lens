import { randomUUID, type webcrypto } from 'node:crypto';
import type { MessageQueue, MessageQueueEnqueueOptions } from '@fedify/fedify';
import { createFederation } from '@fedify/fedify';
import { PostgresKvStore } from '@fedify/postgres';
import type postgres from 'postgres';
import { parseCanonicalOrigin } from './canonical-origin.ts';
import {
  assertStoredMessageHasNoPrivateJwk,
  buildOutboxDedupeKey,
  type PostgresQueueEnqueueOptions,
  parseStoredQueueMessage,
  redactFedifyQueueMessageForStorage,
  rehydrateStoredOutboxMessage,
  type StoredOutboxMessage,
  toFedifyMessage,
  UnsupportedFedifyQueueMessageError,
} from './queue.ts';
import {
  assertActivityPubDbTestRuntime,
  assertTestOnlyPrivateAddressAllowed,
} from './test-runtime-guard.ts';

type JsonWebKey = webcrypto.JsonWebKey;

const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const ACTIVITYPUB_DELIVERY_FAILED = 'activitypub_delivery_failed';

type QueueRow = {
  id: string;
  dedupe_key: string;
  message_json: StoredOutboxMessage;
  ordering_key: string | null;
  worker_token: string | null;
};

/**
 * Creates the official Fedify PostgreSQL KV store for ActivityPub state.
 * Fedify 2.3.4 must pass `initialized: false` so the first-use `initialize()` call
 * probes postgres.js JSON serialization; `initialized: true` skips that probe and
 * stores object values as JSONB strings instead of objects.
 */
export function createPostgresFedifyKvStore(input: { sql: postgres.Sql; initialized?: boolean }) {
  void input.initialized;
  return new PostgresKvStore(input.sql, {
    tableName: 'activitypub_fedify_kv',
    initialized: false,
  });
}

/** Creates the custom PostgreSQL-backed Fedify queue adapter for outbox delivery. */
export function createPostgresQueueAdapter(input: { sql: postgres.Sql; canonicalOrigin: string }) {
  const { origin: canonicalOrigin } = parseCanonicalOrigin(input.canonicalOrigin);

  const queue: MessageQueue & {
    enqueue(message: unknown, options?: PostgresQueueEnqueueOptions): Promise<void>;
  } = {
    nativeRetrial: true,
    async enqueue(message: unknown, options?: PostgresQueueEnqueueOptions) {
      assertEnqueueDelaySupported(options?.delay);
      const stored = redactFedifyQueueMessageForStorage(message);
      assertStoredMessageHasNoPrivateJwk(stored);
      assertStoredOutboxMessageMatchesCanonicalOrigin(stored, canonicalOrigin);
      const dedupeKey = buildOutboxDedupeKey({
        activityId: stored.activityId ?? '',
        recipientInbox: stored.inbox,
      });
      if (options?.dedupeKey && options.dedupeKey !== dedupeKey) {
        throw new UnsupportedFedifyQueueMessageError(
          'dedupeKey conflict with computed outbox dedupe key',
        );
      }
      const orderingKey = options?.orderingKey ?? stored.orderingKey ?? null;
      if (orderingKey && stored.orderingKey && orderingKey !== stored.orderingKey) {
        throw new UnsupportedFedifyQueueMessageError(
          'orderingKey conflict between enqueue options and message',
        );
      }
      const recipientOrigin = normalizeRecipientOrigin(stored.inbox);

      await input.sql`
        INSERT INTO public.activitypub_queue_messages (
          id,
          dedupe_key,
          queue_kind,
          ordering_key,
          recipient_origin,
          message_json,
          status,
          available_at,
          attempt_count,
          created_at,
          updated_at
        )
        VALUES (
          ${randomUUID()},
          ${dedupeKey},
          'outbox',
          ${orderingKey ?? stored.orderingKey ?? null},
          ${recipientOrigin},
          ${input.sql.json(stored as never)},
          'pending',
          now(),
          0,
          now(),
          now()
        )
        ON CONFLICT (dedupe_key) DO NOTHING
      `;
    },
    async listen() {
      throw new Error('PostgreSQL queue adapter does not support listen()');
    },
  };

  return queue;
}

/** Inspects the next due queue row without leasing or status updates; returns null when none remain. */
export async function claimOnePostgresQueueMessage(input: {
  sql: postgres.Sql;
}): Promise<StoredOutboxMessage | null> {
  const rows = await input.sql<QueueRow[]>`
    SELECT id, dedupe_key, message_json, ordering_key, worker_token
    FROM public.activitypub_queue_messages
    WHERE status IN ('pending', 'retry_wait')
      AND available_at <= now()
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }
  return parseStoredQueueMessage(row.message_json);
}

/** Persists a Step 1 local DB test actor key pair; not production encrypted-key storage. */
export async function persistTestActorKey(input: {
  sql: postgres.Sql;
  tableName: string;
  actorId: string;
  keyId: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}) {
  assertActivityPubDbTestRuntime();
  const tableName = assertSafeTableName(input.tableName);
  await input.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.${tableName} (
      actor_id UUID PRIMARY KEY,
      key_id TEXT NOT NULL,
      public_jwk JSONB NOT NULL,
      private_jwk JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await input.sql.unsafe(
    `
      INSERT INTO public.${tableName} (actor_id, key_id, public_jwk, private_jwk)
      VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb)
      ON CONFLICT (actor_id) DO UPDATE
      SET key_id = EXCLUDED.key_id,
          public_jwk = EXCLUDED.public_jwk,
          private_jwk = EXCLUDED.private_jwk,
          updated_at = now()
    `,
    [input.actorId, input.keyId, JSON.stringify(input.publicJwk), JSON.stringify(input.privateJwk)],
  );
}

/** Reloads a Step 1 local DB test actor key pair; not production encrypted-key storage. */
export async function reloadTestActorKey(input: {
  sql: postgres.Sql;
  tableName: string;
  actorId: string;
}) {
  assertActivityPubDbTestRuntime();
  const tableName = assertSafeTableName(input.tableName);
  const rows = await input.sql.unsafe<
    {
      actor_id: string;
      key_id: string;
      public_jwk: unknown;
      private_jwk: unknown;
    }[]
  >(
    `SELECT actor_id, key_id, public_jwk, private_jwk
     FROM public.${tableName}
     WHERE actor_id = $1::uuid`,
    [input.actorId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error('test actor key not found');
  }
  return {
    actorId: row.actor_id,
    keyId: row.key_id,
    publicJwk: parseReloadedJwk(row.public_jwk, 'public JWK'),
    privateJwk: parseReloadedJwk(row.private_jwk, 'private JWK'),
  };
}

/** Normalizes JSONB JWK values that postgres.js may return as objects or JSON strings. */
function parseReloadedJwk(value: unknown, label: string): JsonWebKey {
  let candidate: unknown = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value);
    } catch {
      throw new Error(`invalid ${label} JSON from database`);
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`invalid ${label} shape from database`);
  }
  const jwk = candidate as Record<string, unknown>;
  if (typeof jwk.kty !== 'string' || jwk.kty.length === 0) {
    throw new Error(`invalid ${label} type from database`);
  }
  return jwk as JsonWebKey;
}

export type OneShotDispatchResult =
  | { status: 'processed'; processor: 'Federation.processQueuedTask'; messageId: string }
  | { status: 'no-op' };

/** Input for the one-shot outbox processor used by the dispatch CLI. */
export type ProcessOneQueuedOutboxMessageInput = {
  sql: postgres.Sql;
  canonicalOrigin: string;
  actorTable: string;
  actorId: string;
  /**
   * Test-only escape hatch for localhost fixture delivery.
   * Must be enabled only from the ACTIVITYPUB_RUN_DB_TESTS=1 dispatch path.
   */
  testOnlyAllowPrivateAddress?: boolean;
};

/** Claims and processes exactly one queued outbox message through Fedify manual task processing. */
export async function processOneQueuedOutboxMessage(
  input: ProcessOneQueuedOutboxMessageInput,
): Promise<OneShotDispatchResult> {
  assertActivityPubDbTestRuntime();
  assertTestOnlyPrivateAddressAllowed(input.testOnlyAllowPrivateAddress);

  const claimed = await claimQueueRow(input.sql);
  if (!claimed) {
    return { status: 'no-op' };
  }

  try {
    const actorKey = await reloadTestActorKey({
      sql: input.sql,
      tableName: input.actorTable,
      actorId: input.actorId,
    });
    const stored = parseStoredQueueMessage(claimed.message_json);
    for (const key of stored.keys) {
      if (key.keyId !== actorKey.keyId) {
        throw new Error('stored queue message keyId does not match reloaded actor key');
      }
    }

    const rehydrated = await rehydrateStoredOutboxMessage(stored, async (keyId) => {
      if (keyId !== actorKey.keyId) {
        throw new Error('unknown actor key reference in queue message');
      }
      return actorKey.privateJwk;
    });

    const queue = createPostgresQueueAdapter({
      sql: input.sql,
      canonicalOrigin: input.canonicalOrigin,
    });
    const federation = createFederation({
      kv: createPostgresFedifyKvStore({ sql: input.sql, initialized: true }),
      queue,
      manuallyStartQueue: true,
      allowPrivateAddress: input.testOnlyAllowPrivateAddress ?? false,
      origin: input.canonicalOrigin,
    });

    await federation.processQueuedTask(undefined, toFedifyMessage(rehydrated));
    await finalizeQueueSuccess(input.sql, claimed.id, claimed.worker_token);
    return {
      status: 'processed',
      processor: 'Federation.processQueuedTask',
      messageId: claimed.id,
    };
  } catch (error) {
    try {
      await finalizeQueueFailure(input.sql, claimed.id, claimed.worker_token);
    } catch {
      // Preserve the original delivery error when queue finalization also fails.
    }
    throw error;
  }
}

async function claimQueueRow(
  sql: postgres.Sql,
): Promise<(QueueRow & { worker_token: string }) | null> {
  return sql.begin(async (transaction) => {
    const rows = await transaction<QueueRow[]>`
      SELECT id, dedupe_key, message_json, ordering_key, worker_token
      FROM public.activitypub_queue_messages
      WHERE status IN ('pending', 'retry_wait')
        AND available_at <= now()
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }
    const workerToken = randomUUID();
    const updated = await transaction<{ id: string }[]>`
      UPDATE public.activitypub_queue_messages
      SET status = 'running',
          worker_token = ${workerToken},
          lease_expires_at = now() + interval '15 minutes',
          started_at = COALESCE(started_at, now()),
          attempt_count = attempt_count + 1,
          updated_at = now()
      WHERE id = ${row.id}
        AND status IN ('pending', 'retry_wait')
      RETURNING id
    `;
    if (updated.length === 0) {
      return null;
    }
    return {
      ...row,
      worker_token: workerToken,
    };
  });
}

async function finalizeQueueSuccess(sql: postgres.Sql, id: string, workerToken: string) {
  await sql`
    UPDATE public.activitypub_queue_messages
    SET status = 'succeeded',
        worker_token = NULL,
        lease_expires_at = NULL,
        completed_at = now(),
        updated_at = now()
    WHERE id = ${id}
      AND worker_token = ${workerToken}
      AND (lease_expires_at IS NULL OR lease_expires_at > now())
  `;
}

async function finalizeQueueFailure(sql: postgres.Sql, id: string, workerToken: string) {
  await sql`
    UPDATE public.activitypub_queue_messages
    SET status = 'retry_wait',
        worker_token = NULL,
        lease_expires_at = NULL,
        available_at = now() + interval '1 minute',
        last_error_code = ${ACTIVITYPUB_DELIVERY_FAILED},
        updated_at = now()
    WHERE id = ${id}
      AND worker_token = ${workerToken}
      AND (lease_expires_at IS NULL OR lease_expires_at > now())
  `;
}

function assertEnqueueDelaySupported(delay: MessageQueueEnqueueOptions['delay']): void {
  if (!delay) {
    return;
  }
  if (delay.total('millisecond') !== 0) {
    throw new UnsupportedFedifyQueueMessageError('enqueue delay is not supported');
  }
}

function assertStoredOutboxMessageMatchesCanonicalOrigin(
  stored: StoredOutboxMessage,
  canonicalOrigin: string,
): void {
  assertUrlMatchesCanonicalOrigin(stored.baseUrl, 'baseUrl', canonicalOrigin);
  if (stored.activityId) {
    assertUrlMatchesCanonicalOrigin(stored.activityId, 'activityId', canonicalOrigin);
  }
  if (stored.orderingKey) {
    assertUrlMatchesCanonicalOrigin(stored.orderingKey, 'orderingKey', canonicalOrigin);
  }
  stored.keys.forEach((key, index) => {
    assertUrlMatchesCanonicalOrigin(key.keyId, `keys[${index}].keyId`, canonicalOrigin);
  });
  if (stored.actorIds) {
    stored.actorIds.forEach((actorId, index) => {
      assertUrlMatchesCanonicalOrigin(actorId, `actorIds[${index}]`, canonicalOrigin);
    });
  }
}

function assertUrlMatchesCanonicalOrigin(
  url: string,
  field: string,
  canonicalOrigin: string,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsupportedFedifyQueueMessageError(`${field} must be a valid URL`);
  }
  if (parsed.origin !== canonicalOrigin) {
    throw new UnsupportedFedifyQueueMessageError(`${field} origin does not match canonical origin`);
  }
}

function assertSafeTableName(tableName: string): string {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(`invalid table name: ${tableName}`);
  }
  return tableName;
}

function normalizeRecipientOrigin(inbox: string): string {
  const parsed = new URL(inbox);
  return parsed.origin;
}
