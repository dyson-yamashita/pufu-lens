import { randomUUID, type webcrypto } from 'node:crypto';
import type { KvStore, MessageQueue, MessageQueueEnqueueOptions } from '@fedify/fedify';
import { createFederation, exportJwk } from '@fedify/fedify';
import { PostgresKvStore } from '@fedify/postgres';
import type { DocumentLoader } from '@fedify/vocab-runtime';
import type postgres from 'postgres';
import type { ActivityPubRepository } from './actor-repository.ts';
import { parseCanonicalOrigin } from './canonical-origin.ts';
import type { DeliveryErrorCode } from './delivery-errors.ts';
import { DELIVERY_ERROR_CODES, LeaseLostError, mapDeliveryError } from './delivery-errors.ts';
import { withTimedDeliveryFetch } from './delivery-fetch.ts';
import { createDeliveryHeartbeatController } from './delivery-heartbeat.ts';
import { createDeliveryErrorObserver, toObservedDeliveryError } from './delivery-observer.ts';
import {
  type ActivityPubDispatcherClock,
  classifyDeliveryFailure,
  computeHeartbeatLeaseExpiry,
  DISPATCHER_LEASE_MS,
  isBlockedByOrderingPredecessor,
  PREDECESSOR_FAILURE_CODE,
  parseRetryAfterHeader,
} from './dispatcher.ts';
import {
  createProductionActivityPubFederation,
  createTestActivityPubFederation,
} from './federation.ts';
import { processStoredInboxViaVerifiedListenerHarness } from './follow-inbox-listener-harness.ts';
import { createActivityPubFollowUseCases } from './follow-use-cases.ts';
import { createActivityPubInboundReportUseCasesWithSql } from './inbound-report-use-cases.ts';
import {
  assertStoredMessageHasNoPrivateJwk,
  buildInboxDedupeKey,
  buildOutboxDedupeKey,
  extractHttpsActivityId,
  type PostgresQueueEnqueueOptions,
  parseStoredQueueMessage,
  redactFedifyQueueMessageForStorage,
  rehydrateStoredOutboxMessage,
  type StoredOutboxMessage,
  type StoredQueueMessage,
  toFedifyMessage,
  UnsupportedFedifyQueueMessageError,
} from './queue.ts';
import type { RemoteActorResolver } from './remote-actor.ts';
import type { RemoteArticleResolver } from './remote-article.ts';
import type { BlockedDomainPredicate } from './remote-document.ts';
import { sqlInsertReturnedRow } from './schema.ts';
import {
  assertActivityPubDbTestRuntime,
  assertActivityPubHermeticE2eRuntime,
  assertTestDeliveryFetchTimeoutMsAllowed,
  assertTestOnlyPrivateAddressAllowed,
  assertTestRemoteActorResolverAllowed,
  assertTestRemoteArticleResolverAllowed,
  shouldUseHermeticInboxQueueProcessor,
} from './test-runtime-guard.ts';
import { buildActivityPubUriContract } from './uri-contract.ts';

type JsonWebKey = webcrypto.JsonWebKey;

const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

type QueueRow = {
  id: string;
  dedupe_key: string;
  message_json: StoredQueueMessage;
  ordering_key: string | null;
  worker_token: string | null;
  queue_kind: 'inbox' | 'outbox';
};

/**
 * Creates the official Fedify PostgreSQL KV store for ActivityPub state.
 * Fedify 2.3.4 must pass `initialized: false` so the first-use `initialize()` call
 * probes postgres.js JSON serialization; `initialized: true` skips that probe and
 * stores object values as JSONB strings instead of objects.  The wrapper also
 * encodes JSON `null`, which postgres.js otherwise binds as SQL NULL and the
 * official NOT NULL schema correctly rejects.
 */
export function createPostgresFedifyKvStore(input: { sql: postgres.Sql }): KvStore {
  const store = new PostgresKvStore(input.sql, {
    tableName: 'activitypub_fedify_kv',
    initialized: false,
  });
  const nullSentinel = { __pufu_lens_fedify_json_null__: true } as const;
  // decode maps the JSON-null sentinel back to JavaScript null; undefined means missing key.
  // Sentinel collision with legitimate stored values is assumed impossible in practice.
  const decode = <T>(value: T): T | null => (isFedifyJsonNullSentinel(value) ? null : value);
  return {
    async get<T = unknown>(key: Parameters<KvStore['get']>[0]) {
      return decode(await store.get<T>(key)) as T | undefined;
    },
    set(
      key: Parameters<KvStore['set']>[0],
      value: Parameters<KvStore['set']>[1],
      options?: Parameters<KvStore['set']>[2],
    ) {
      return store.set(key, value === null ? nullSentinel : value, options);
    },
    delete(key: Parameters<KvStore['delete']>[0]) {
      return store.delete(key);
    },
    async *list(prefix?: Parameters<KvStore['list']>[0]) {
      for await (const entry of store.list(prefix)) {
        yield { key: entry.key, value: decode(entry.value) };
      }
    },
  };
}

function isFedifyJsonNullSentinel(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length === 1 &&
    entries[0]?.[0] === '__pufu_lens_fedify_json_null__' &&
    entries[0]?.[1] === true
  );
}

function readInboxActivityType(activity: unknown): string | null {
  if (typeof activity !== 'object' || activity === null || Array.isArray(activity)) {
    return null;
  }
  const activityType = Reflect.get(activity, 'type');
  if (typeof activityType !== 'string' || activityType.length === 0) {
    return null;
  }
  return activityType;
}

function readInboxActivityActorUri(activity: unknown): string {
  if (typeof activity !== 'object' || activity === null || Array.isArray(activity)) {
    throw new Error('inbox activity missing actor');
  }
  const actor = Reflect.get(activity, 'actor');
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new Error('inbox activity missing actor');
  }
  return actor;
}

type QueueSql = postgres.Sql | postgres.TransactionSql;

/** Event payload for a newly inserted inbox queue row; excludes actor, activity, and payload identifiers. */
export type PostgresQueueInboxEnqueuedEvent = {
  readonly activityType: string | null;
};

/**
 * Creates the custom PostgreSQL-backed Fedify queue adapter for inbox persistence and outbox delivery.
 * `onInboxEnqueued` runs only after a new inbox row is inserted and is awaited before `enqueue()` resolves.
 */
export function createPostgresQueueAdapter(input: {
  sql: QueueSql;
  canonicalOrigin: string;
  onInboxEnqueued?: (event: PostgresQueueInboxEnqueuedEvent) => void | Promise<void>;
}) {
  const { origin: canonicalOrigin } = parseCanonicalOrigin(input.canonicalOrigin);

  const queue: MessageQueue & {
    enqueue(message: unknown, options?: PostgresQueueEnqueueOptions): Promise<void>;
  } = {
    nativeRetrial: true,
    async enqueue(message: unknown, options?: PostgresQueueEnqueueOptions) {
      assertEnqueueDelaySupported(options?.delay);
      const stored = redactFedifyQueueMessageForStorage(message);
      assertStoredMessageHasNoPrivateJwk(stored);

      if (stored.type === 'inbox') {
        const activityId = extractHttpsActivityId(stored.activity);
        const dedupeKey = buildInboxDedupeKey({ activityId });
        const insertResult = await input.sql`
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
            'inbox',
            NULL,
            NULL,
            ${input.sql.json(stored as never)},
            'pending',
            now(),
            0,
            now(),
            now()
          )
          ON CONFLICT (dedupe_key) DO NOTHING
          RETURNING id
        `;
        if (sqlInsertReturnedRow(insertResult) && input.onInboxEnqueued) {
          await input.onInboxEnqueued({
            activityType: readInboxActivityType(stored.activity),
          });
        }
        return;
      }

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
}): Promise<StoredQueueMessage | null> {
  const rows = await input.sql<QueueRow[]>`
    SELECT id, dedupe_key, message_json, ordering_key, worker_token, queue_kind
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
  const stored = parseStoredQueueMessage(row.message_json);
  assertStoredMessageMatchesQueueKind(stored, row.queue_kind);
  return stored;
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
  | {
      status: 'processed';
      processor: 'Federation.processQueuedTask';
      messageId: string;
      queueKind: 'inbox' | 'outbox';
    }
  | {
      status: 'delivery_failed';
      messageId: string;
      queueKind: 'inbox' | 'outbox';
    }
  | { status: 'no-op' };

/** Input for the production one-shot queue processor used by dispatch jobs. */
export type ProcessOneQueuedMessageInput = {
  sql: postgres.Sql;
  canonicalOrigin: string;
  encryptionKey: Buffer;
  actorRepository: ActivityPubRepository;
  /**
   * Test-only escape hatch for localhost fixture delivery.
   * Must be enabled only from the ACTIVITYPUB_RUN_DB_TESTS=1 dispatch path.
   */
  testOnlyAllowPrivateAddress?: boolean;
  /** Test-only remote actor resolver override for inbox queue contract tests. */
  testRemoteActorResolver?: RemoteActorResolver;
  /** Test-only remote Article resolver override for inbound report queue tests. */
  testRemoteArticleResolver?: RemoteArticleResolver;
  /** Test-only delivery fetch timeout override for hermetic fault injection. */
  testDeliveryFetchTimeoutMs?: number;
  /** Test-only JSON-LD loader used by the hermetic in-memory host router. */
  testDocumentLoaderFactory?: () => DocumentLoader;
  /** Blocked domain predicate for inbound report remote fetches. */
  isDomainBlocked?: BlockedDomainPredicate;
  /** Optional queue kind preference for fair inbox/outbox claiming. */
  preferredQueueKind?: 'inbox' | 'outbox';
  /** Injectable clock for deterministic dispatcher tests. */
  clock?: ActivityPubDispatcherClock;
  /** Injectable heartbeat callback used during potentially slow delivery. */
  heartbeat?: (input: { messageId: string; workerToken: string }) => Promise<boolean>;
  /** Heartbeat interval in milliseconds for long-running delivery. */
  heartbeatIntervalMs?: number;
};

/** Claims and processes exactly one queued inbox or outbox message through Fedify manual task processing. */
export async function processOneQueuedMessage(
  input: ProcessOneQueuedMessageInput,
): Promise<OneShotDispatchResult> {
  assertTestOnlyPrivateAddressAllowed(input.testOnlyAllowPrivateAddress);
  assertTestRemoteActorResolverAllowed(input.testRemoteActorResolver);
  assertTestRemoteArticleResolverAllowed(input.testRemoteArticleResolver);
  assertTestDeliveryFetchTimeoutMsAllowed(input.testDeliveryFetchTimeoutMs);
  if (input.testDocumentLoaderFactory) {
    assertActivityPubHermeticE2eRuntime();
  }

  const claimed = await claimQueueRow({
    sql: input.sql,
    preferredQueueKind: input.preferredQueueKind,
    clock: input.clock,
  });
  if (!claimed) {
    return { status: 'no-op' };
  }

  try {
    const stored = parseStoredQueueMessage(claimed.message_json);
    assertStoredMessageMatchesQueueKind(stored, claimed.queue_kind);

    const followUseCases = createActivityPubFollowUseCases({
      canonicalOrigin: input.canonicalOrigin,
      sql: input.sql,
      encryptionKey: input.encryptionKey,
      actorRepository: input.actorRepository,
      ...(input.testRemoteActorResolver
        ? { remoteActorResolver: input.testRemoteActorResolver }
        : {}),
    });
    const inboundReportUseCases = createActivityPubInboundReportUseCasesWithSql({
      canonicalOrigin: input.canonicalOrigin,
      sql: input.sql,
      isDomainBlocked: input.isDomainBlocked ?? (() => false),
      ...(input.testRemoteArticleResolver
        ? { remoteArticleResolver: input.testRemoteArticleResolver }
        : {}),
    });

    const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 30_000;
    const heartbeat =
      input.heartbeat ??
      (async ({ messageId, workerToken }) =>
        heartbeatPostgresQueueMessage({
          sql: input.sql,
          messageId,
          workerToken,
          clock: input.clock,
        }));
    const heartbeatController = createDeliveryHeartbeatController({
      heartbeat,
      messageId: claimed.id,
      workerToken: claimed.worker_token,
      heartbeatIntervalMs,
    });
    heartbeatController.start();
    let heartbeatLost = false;

    try {
      await withTimedDeliveryFetch(
        {
          ...(input.testDeliveryFetchTimeoutMs !== undefined
            ? { timeoutMs: input.testDeliveryFetchTimeoutMs }
            : {}),
        },
        async () => {
          if (
            stored.type === 'inbox' &&
            input.testOnlyAllowPrivateAddress &&
            !shouldUseHermeticInboxQueueProcessor()
          ) {
            const signedActorUri = readInboxActivityActorUri(stored.activity);
            await processStoredInboxViaVerifiedListenerHarness({
              stored,
              canonicalOrigin: input.canonicalOrigin,
              actorRepository: input.actorRepository,
              followUseCases,
              inboundReportUseCases,
              signedActorUri,
              recipientUsername: stored.identifier,
            });
          } else {
            const queue = createPostgresQueueAdapter({
              sql: input.sql,
              canonicalOrigin: input.canonicalOrigin,
            });
            const deliveryObserver = createDeliveryErrorObserver();
            const federationBuilder = input.testOnlyAllowPrivateAddress
              ? createTestActivityPubFederation
              : createProductionActivityPubFederation;
            const testDocumentLoaderFactory = input.testDocumentLoaderFactory;
            const federation = await federationBuilder({
              canonicalOrigin: input.canonicalOrigin,
              repository: input.actorRepository,
              followUseCases,
              inboundReportUseCases,
              kv: createPostgresFedifyKvStore({
                sql: input.sql,
              }),
              queue,
              deliveryObserver,
              ...(testDocumentLoaderFactory
                ? {
                    testDocumentLoaderFactory,
                    testContextLoaderFactory: testDocumentLoaderFactory,
                    testAuthenticatedDocumentLoaderFactory: () => testDocumentLoaderFactory(),
                  }
                : {}),
              ...(input.testOnlyAllowPrivateAddress
                ? { allowPrivateAddress: !testDocumentLoaderFactory }
                : {}),
            });

            if (stored.type === 'inbox') {
              try {
                await federation.processQueuedTask(undefined, toFedifyMessage(stored));
              } catch (deliveryError) {
                const observed = deliveryObserver.consume();
                if (observed) {
                  throw toObservedDeliveryError(observed);
                }
                throw deliveryError;
              }
            } else {
              const uri = buildActivityPubUriContract(input.canonicalOrigin);
              const rehydrated = await rehydrateStoredOutboxMessage(stored, async (keyId) => {
                const username = extractPreferredUsernameFromKeyId(keyId);
                const expectedKeyId = uri.actorKeyId(username);
                const expectedActorUrl = uri.actorUrl(username);
                if (keyId !== expectedKeyId) {
                  throw new Error('outbox queue message key binding rejected');
                }
                if (!stored.actorIds?.includes(expectedActorUrl)) {
                  throw new Error('outbox queue message actor binding rejected');
                }
                const actor =
                  await input.actorRepository.findRemotelyVisibleActorByUsername(username);
                if (!actor) {
                  throw new Error('unknown actor for outbox queue key');
                }
                const keyPair = await input.actorRepository.importActorCryptoKeyPair(actor.id);
                return exportJwk(keyPair.privateKey);
              });
              try {
                await federation.processQueuedTask(undefined, toFedifyMessage(rehydrated));
              } catch (deliveryError) {
                const observed = deliveryObserver.consume();
                if (observed) {
                  throw toObservedDeliveryError(observed);
                }
                throw deliveryError;
              }
            }

            const observed = deliveryObserver.consume();
            if (observed) {
              throw toObservedDeliveryError(observed);
            }
          }
        },
      );
    } finally {
      heartbeatLost = await heartbeatController.stop();
    }

    if (heartbeatLost) {
      throw new LeaseLostError();
    }

    await finalizeQueueSuccess(input.sql, claimed.id, claimed.worker_token, input.clock);
    return {
      status: 'processed',
      processor: 'Federation.processQueuedTask',
      messageId: claimed.id,
      queueKind: claimed.queue_kind,
    };
  } catch (error) {
    if (error instanceof LeaseLostError) {
      throw error;
    }
    try {
      await finalizeQueueFailure({
        sql: input.sql,
        id: claimed.id,
        workerToken: claimed.worker_token,
        attemptCount: claimed.attempt_count,
        error,
        clock: input.clock,
      });
    } catch (finalizeError) {
      if (finalizeError instanceof LeaseLostError) {
        throw finalizeError;
      }
      console.error(
        JSON.stringify({
          event: 'activitypub_queue_finalize_failure',
          messageId: claimed.id,
          queueKind: claimed.queue_kind,
          errorCode: mapDeliveryError(error).code,
        }),
      );
    }
    if (isExpectedDeliveryFailure(error)) {
      return {
        status: 'delivery_failed',
        messageId: claimed.id,
        queueKind: claimed.queue_kind,
      };
    }
    throw error;
  }
}

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

  const claimed = await claimQueueRow({ sql: input.sql });
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
    if (stored.type !== 'outbox') {
      throw new Error('processOneQueuedOutboxMessage only supports outbox rows');
    }
    if (claimed.queue_kind !== 'outbox') {
      throw new Error('queue_kind does not match stored outbox payload');
    }
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
      kv: createPostgresFedifyKvStore({ sql: input.sql }),
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
      queueKind: claimed.queue_kind,
    };
  } catch (error) {
    try {
      await finalizeQueueFailure({
        sql: input.sql,
        id: claimed.id,
        workerToken: claimed.worker_token,
        attemptCount: claimed.attempt_count,
        error,
      });
    } catch (finalizeError) {
      if (!(finalizeError instanceof LeaseLostError)) {
        console.error(
          JSON.stringify({
            event: 'activitypub_queue_finalize_failure',
            messageId: claimed.id,
            queueKind: claimed.queue_kind,
            errorCode: mapDeliveryError(error).code,
          }),
        );
      }
    }
    throw error;
  }
}

type ClaimedQueueRow = QueueRow & {
  worker_token: string;
  attempt_count: number;
};

async function claimQueueRow(input: {
  sql: postgres.Sql;
  preferredQueueKind?: 'inbox' | 'outbox';
  clock?: ActivityPubDispatcherClock;
}): Promise<ClaimedQueueRow | null> {
  const clock = input.clock ?? { now: () => new Date() };
  return input.sql.begin(async (transaction) => {
    await transaction`
      UPDATE public.activitypub_queue_messages
      SET status = 'pending',
          worker_token = NULL,
          lease_expires_at = NULL,
          attempt_lease_started_at = NULL,
          available_at = ${clock.now()},
          updated_at = ${clock.now()}
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ${clock.now()}
    `;

    const queueKinds: readonly ('inbox' | 'outbox')[] =
      input.preferredQueueKind === 'outbox' ? ['outbox', 'inbox'] : ['inbox', 'outbox'];

    for (const queueKind of queueKinds) {
      const rows = await transaction<
        (QueueRow & {
          recipient_origin: string | null;
          attempt_count: number;
        })[]
      >`
        SELECT id, dedupe_key, message_json, ordering_key, worker_token, queue_kind, recipient_origin, attempt_count
        FROM public.activitypub_queue_messages q
        WHERE status IN ('pending', 'retry_wait')
          AND available_at <= ${clock.now()}
          AND queue_kind = ${queueKind}
          AND (
            q.queue_kind <> 'outbox'
            OR q.ordering_key IS NULL
            OR q.recipient_origin IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM public.activitypub_queue_messages p
              WHERE p.queue_kind = 'outbox'
                AND p.ordering_key = q.ordering_key
                AND p.recipient_origin = q.recipient_origin
                AND (p.created_at, p.id) < (q.created_at, q.id)
                AND p.status NOT IN ('succeeded', 'retry_exhausted', 'permanent_failure')
            )
          )
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 20
      `;
      for (const row of rows) {
        const gate = await evaluateOrderingGate(transaction, row);
        if (gate.kind === 'block') {
          continue;
        }
        if (gate.kind === 'terminalize') {
          await transaction`
            UPDATE public.activitypub_queue_messages
            SET status = ${gate.terminalStatus},
                worker_token = NULL,
                lease_expires_at = NULL,
                attempt_lease_started_at = NULL,
                last_error_code = ${PREDECESSOR_FAILURE_CODE},
                completed_at = ${clock.now()},
                updated_at = ${clock.now()}
            WHERE id = ${row.id}
          `;
          continue;
        }
        const workerToken = randomUUID();
        const leaseExpiresAt = new Date(clock.now().getTime() + DISPATCHER_LEASE_MS);
        const updatedRows = (await transaction`
          UPDATE public.activitypub_queue_messages
          SET status = 'running',
              worker_token = ${workerToken},
              lease_expires_at = ${leaseExpiresAt},
              attempt_lease_started_at = ${clock.now()},
              started_at = COALESCE(started_at, ${clock.now()}),
              attempt_count = attempt_count + 1,
              updated_at = ${clock.now()}
          WHERE id = ${row.id}
            AND status IN ('pending', 'retry_wait')
          RETURNING id, attempt_count
        `) as readonly unknown[];
        if (updatedRows.length === 0) {
          continue;
        }
        const claimedAttemptCount = parseClaimedQueueAttemptCount(updatedRows[0]);
        return {
          ...row,
          worker_token: workerToken,
          attempt_count: claimedAttemptCount,
        };
      }
    }
    return null;
  });
}

async function evaluateOrderingGate(
  transaction: postgres.TransactionSql,
  row: QueueRow & { recipient_origin: string | null },
): Promise<
  | { readonly kind: 'claim' }
  | { readonly kind: 'block' }
  | {
      readonly kind: 'terminalize';
      readonly terminalStatus: 'retry_exhausted' | 'permanent_failure';
    }
> {
  if (row.queue_kind !== 'outbox' || !row.ordering_key || !row.recipient_origin) {
    return { kind: 'claim' };
  }
  const predecessors = (await transaction`
    SELECT status, id::text AS id, created_at, attempt_count
    FROM public.activitypub_queue_messages
    WHERE queue_kind = 'outbox'
      AND ordering_key = ${row.ordering_key}
      AND recipient_origin = ${row.recipient_origin}
      AND (created_at, id) < (
        SELECT created_at, id
        FROM public.activitypub_queue_messages
        WHERE id = ${row.id}
      )
      AND status <> 'succeeded'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `) as readonly unknown[];
  const predecessor = predecessors[0] ? parseOrderingPredecessorRow(predecessors[0]) : undefined;
  if (!predecessor) {
    return { kind: 'claim' };
  }
  const gate = isBlockedByOrderingPredecessor({
    hasOlderIncompletePredecessor: true,
    predecessorTerminalFailure:
      predecessor.status === 'retry_exhausted' || predecessor.status === 'permanent_failure',
  });
  if (gate === 'claim') {
    return { kind: 'claim' };
  }
  if (gate === 'block') {
    return { kind: 'block' };
  }
  return {
    kind: 'terminalize',
    terminalStatus:
      predecessor.status === 'retry_exhausted' ? 'retry_exhausted' : 'permanent_failure',
  };
}

async function finalizeQueueSuccess(
  sql: postgres.Sql,
  id: string,
  workerToken: string,
  clock?: ActivityPubDispatcherClock,
) {
  const now = clock?.now() ?? new Date();
  const updated = await sql`
    UPDATE public.activitypub_queue_messages
    SET status = 'succeeded',
        worker_token = NULL,
        lease_expires_at = NULL,
        attempt_lease_started_at = NULL,
        completed_at = ${now},
        updated_at = ${now}
    WHERE id = ${id}
      AND worker_token = ${workerToken}
      AND status = 'running'
      AND lease_expires_at > ${now}
  `;
  if (updated.count === 0) {
    throw new LeaseLostError();
  }
}

async function finalizeQueueFailure(input: {
  sql: postgres.Sql;
  id: string;
  workerToken: string;
  attemptCount: number;
  error: unknown;
  clock?: ActivityPubDispatcherClock;
}) {
  const now = input.clock?.now() ?? new Date();
  const processorError = toDeliveryProcessorError(input.error);
  const classification = classifyDeliveryFailure({
    attemptCount: input.attemptCount,
    error: processorError,
  });
  let updated: { count: number };
  if (classification.kind === 'retry_exhausted') {
    updated = await input.sql`
      UPDATE public.activitypub_queue_messages
      SET status = 'retry_exhausted',
          worker_token = NULL,
          lease_expires_at = NULL,
          attempt_lease_started_at = NULL,
          last_error_code = ${processorError.code},
          last_http_status = ${processorError.httpStatus ?? null},
          completed_at = ${now},
          updated_at = ${now}
      WHERE id = ${input.id}
        AND worker_token = ${input.workerToken}
        AND status = 'running'
        AND lease_expires_at > ${now}
    `;
  } else if (classification.kind === 'permanent_failure') {
    updated = await input.sql`
      UPDATE public.activitypub_queue_messages
      SET status = 'permanent_failure',
          worker_token = NULL,
          lease_expires_at = NULL,
          attempt_lease_started_at = NULL,
          last_error_code = ${processorError.code},
          last_http_status = ${processorError.httpStatus ?? null},
          completed_at = ${now},
          updated_at = ${now}
      WHERE id = ${input.id}
        AND worker_token = ${input.workerToken}
        AND status = 'running'
        AND lease_expires_at > ${now}
    `;
  } else {
    updated = await input.sql`
      UPDATE public.activitypub_queue_messages
      SET status = 'retry_wait',
          worker_token = NULL,
          lease_expires_at = NULL,
          attempt_lease_started_at = NULL,
          available_at = ${new Date(now.getTime() + classification.delayMs)},
          last_error_code = ${processorError.code},
          last_http_status = ${processorError.httpStatus ?? null},
          updated_at = ${now}
      WHERE id = ${input.id}
        AND worker_token = ${input.workerToken}
        AND status = 'running'
        AND lease_expires_at > ${now}
    `;
  }
  if (updated.count === 0) {
    throw new LeaseLostError();
  }
}

function parseClaimedQueueAttemptCount(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid claimed queue attempt_count row.');
  }
  const attemptCount = Reflect.get(value, 'attempt_count');
  if (typeof attemptCount !== 'number' || !Number.isInteger(attemptCount) || attemptCount < 0) {
    throw new Error('Invalid claimed queue attempt_count.');
  }
  return attemptCount;
}

function parseOrderingPredecessorRow(value: unknown): {
  readonly status: string;
  readonly id: string;
  readonly createdAt: Date;
  readonly attemptCount: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid ordering predecessor row.');
  }
  const status = Reflect.get(value, 'status');
  const id = Reflect.get(value, 'id');
  const createdAt = Reflect.get(value, 'created_at');
  const attemptCount = Reflect.get(value, 'attempt_count');
  if (typeof status !== 'string' || status.length === 0) {
    throw new Error('Invalid ordering predecessor status.');
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Invalid ordering predecessor id.');
  }
  if (!(createdAt instanceof Date)) {
    throw new Error('Invalid ordering predecessor created_at.');
  }
  if (typeof attemptCount !== 'number' || !Number.isInteger(attemptCount) || attemptCount < 0) {
    throw new Error('Invalid ordering predecessor attempt_count.');
  }
  return { status, id, createdAt, attemptCount };
}

function toDeliveryProcessorError(error: unknown): {
  code: DeliveryErrorCode;
  httpStatus?: number;
  retryAfterMs?: number;
} {
  const mapped = mapDeliveryError(error);
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    const retryAfter =
      typeof record.retryAfter === 'string' ? parseRetryAfterHeader(record.retryAfter) : undefined;
    return {
      code: mapped.code,
      httpStatus: mapped.httpStatus,
      retryAfterMs: mapped.retryAfterMs ?? retryAfter,
    };
  }
  return mapped;
}

/** Exported for deterministic delivery failure boundary tests. */
export function isExpectedDeliveryFailure(error: unknown): boolean {
  if (error instanceof LeaseLostError) {
    return false;
  }
  const mapped = mapDeliveryError(error);
  if (mapped.code === DELIVERY_ERROR_CODES.materializationRetryExhausted) {
    return true;
  }
  if (mapped.httpStatus !== undefined) {
    return true;
  }
  return (
    mapped.code === DELIVERY_ERROR_CODES.deliveryTimeout ||
    mapped.code === DELIVERY_ERROR_CODES.networkError
  );
}

/** Extends a queue message lease when the worker token and lease are still valid. */
export async function heartbeatPostgresQueueMessage(input: {
  readonly sql: postgres.Sql;
  readonly messageId: string;
  readonly workerToken: string;
  readonly clock?: ActivityPubDispatcherClock;
}): Promise<boolean> {
  const clock = input.clock ?? { now: () => new Date() };
  const rows = (await input.sql`
    SELECT attempt_lease_started_at
    FROM public.activitypub_queue_messages
    WHERE id = ${input.messageId}::uuid
      AND worker_token = ${input.workerToken}::uuid
      AND status = 'running'
      AND lease_expires_at > ${clock.now()}
  `) as readonly unknown[];
  const row = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return false;
  }
  const attemptLeaseStartedAt = Reflect.get(row, 'attempt_lease_started_at');
  if (!(attemptLeaseStartedAt instanceof Date) && typeof attemptLeaseStartedAt !== 'string') {
    return false;
  }
  const parsedAttemptLeaseStartedAt =
    attemptLeaseStartedAt instanceof Date ? attemptLeaseStartedAt : new Date(attemptLeaseStartedAt);
  const nextLease = computeHeartbeatLeaseExpiry({
    now: clock.now(),
    attemptLeaseStartedAt: parsedAttemptLeaseStartedAt,
  });
  if (!nextLease) {
    return false;
  }
  const updated = await input.sql`
    UPDATE public.activitypub_queue_messages
    SET lease_expires_at = ${nextLease},
        updated_at = ${clock.now()}
    WHERE id = ${input.messageId}::uuid
      AND worker_token = ${input.workerToken}::uuid
      AND status = 'running'
      AND lease_expires_at > ${clock.now()}
  `;
  return updated.count > 0;
}

/** Terminalizes later queue rows when an ordering predecessor failed permanently. */
export async function terminalizeSuccessorAfterPredecessorFailure(input: {
  readonly sql: postgres.Sql;
  readonly orderingKey: string;
  readonly recipientOrigin: string;
  readonly predecessorId: string;
  readonly terminalStatus: 'retry_exhausted' | 'permanent_failure';
  readonly clock?: ActivityPubDispatcherClock;
}): Promise<number> {
  const clock = input.clock ?? { now: () => new Date() };
  const updated = await input.sql`
    UPDATE public.activitypub_queue_messages
    SET status = ${input.terminalStatus},
        worker_token = NULL,
        lease_expires_at = NULL,
        attempt_lease_started_at = NULL,
        last_error_code = ${PREDECESSOR_FAILURE_CODE},
        completed_at = ${clock.now()},
        updated_at = ${clock.now()}
    WHERE queue_kind = 'outbox'
      AND ordering_key = ${input.orderingKey}
      AND recipient_origin = ${input.recipientOrigin}
      AND status IN ('pending', 'retry_wait')
      AND (created_at, id) > (
        SELECT created_at, id
        FROM public.activitypub_queue_messages
        WHERE id = ${input.predecessorId}::uuid
      )
  `;
  return updated.count;
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

function assertStoredMessageMatchesQueueKind(
  stored: StoredQueueMessage,
  queueKind: 'inbox' | 'outbox',
): void {
  if (stored.type !== queueKind) {
    throw new Error(`queue_kind ${queueKind} does not match stored payload type ${stored.type}`);
  }
}

function extractPreferredUsernameFromKeyId(keyId: string): string {
  const parsed = new URL(keyId);
  const match = parsed.pathname.match(/\/activitypub\/actors\/([^/]+)$/);
  if (!match?.[1]) {
    throw new Error('outbox queue keyId is not a local actor key');
  }
  return decodeURIComponent(match[1]);
}
