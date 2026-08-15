import { randomUUID } from 'node:crypto';
import { exportJwk } from '@fedify/fedify';
import type { DocumentLoader } from '@fedify/vocab-runtime';
import type postgres from 'postgres';
import {
  type ActivityPubRepository,
  createPostgresActivityPubTransactionRepository,
} from './actor-repository.ts';
import type { DeliveryErrorCode } from './delivery-errors.ts';
import { DELIVERY_ERROR_CODES } from './delivery-errors.ts';
import {
  type ActivityPubDispatcherClock,
  DISPATCHER_DEFAULT_BATCH_SIZE,
  DISPATCHER_LEASE_MS,
  DISPATCHER_MAX_ATTEMPTS,
  DISPATCHER_MAX_RUNTIME_MS,
  resolveRetryDelayMs,
  selectNextQueueKind,
} from './dispatcher.ts';
import {
  createPostgresFedifyKvStore,
  createPostgresQueueAdapter,
  processOneQueuedMessage,
} from './postgres.ts';
import { buildOutboxDedupeKey } from './queue.ts';
import type { RemoteActorResolver } from './remote-actor.ts';
import type { RemoteArticleResolver } from './remote-article.ts';
import type { BlockedDomainPredicate } from './remote-document.ts';
import {
  buildStableAnnounceActivityUri,
  buildStableCreateActivityUri,
} from './report-activity-uris.ts';
import {
  dedupeRecipients,
  type FollowAudienceRow,
  parseReportActivityPayload,
  reconstructReportDeliveryRecipients,
} from './report-delivery.ts';
import {
  buildAnnounceActivityJsonLd,
  buildCreateActivityJsonLd,
} from './report-materialization.ts';
import { parseActivityPubActivityRow } from './schema.ts';
import { buildActivityPubUriContract } from './uri-contract.ts';

export type ActivityPubDispatcherRunResult = {
  readonly status: 'completed' | 'deadline';
  readonly activitiesMaterialized: number;
  readonly queueProcessed: number;
  readonly queueNoOps: number;
};

/** Dependencies for the bounded production ActivityPub dispatcher runner. */
export type RunActivityPubDispatcherOnceInput = {
  readonly sql: postgres.Sql;
  readonly canonicalOrigin: string;
  readonly encryptionKey: Buffer;
  readonly actorRepository: ActivityPubRepository;
  readonly isDomainBlocked?: BlockedDomainPredicate;
  readonly clock?: ActivityPubDispatcherClock;
  readonly maxBatchSize?: number;
  readonly maxRuntimeMs?: number;
  readonly testOnlyAllowPrivateAddress?: boolean;
  /** Test-only dependency injection for the hermetic E2E transport. */
  readonly testRemoteActorResolver?: RemoteActorResolver;
  readonly testRemoteArticleResolver?: RemoteArticleResolver;
  readonly testDocumentLoaderFactory?: () => DocumentLoader;
  readonly testDeliveryFetchTimeoutMs?: number;
};

type ClaimedActivity = {
  readonly id: string;
  readonly workerToken: string;
  readonly attemptCount: number;
  readonly activity: ReturnType<typeof parseActivityPubActivityRow>;
};

/**
 * Outcome of classifying a materialization failure for lease-aware activity row updates.
 *
 * - `terminal_failed`: known domain errors that should not be retried.
 * - `lease_lost`: the worker lost its lease; leave recovery to expired-lease reclaim.
 * - `retry_pending`: transient failures that should return the row to `pending` with backoff.
 * - `retry_exhausted`: retry budget reached; terminalize with a safe error code.
 */
export type MaterializationFailureDecision =
  | { readonly kind: 'terminal_failed'; readonly code: DeliveryErrorCode }
  | { readonly kind: 'lease_lost' }
  | { readonly kind: 'retry_pending'; readonly code: DeliveryErrorCode; readonly delayMs: number }
  | { readonly kind: 'retry_exhausted'; readonly code: DeliveryErrorCode };

/**
 * Classifies materialization failures into terminal, retry, lease-lost, or exhausted outcomes
 * without logging secrets or raw transport payloads.
 */
export function classifyMaterializationFailure(input: {
  readonly attemptCount: number;
  readonly error: unknown;
}): MaterializationFailureDecision {
  const code = resolveMaterializationErrorCode(input.error);
  if (code === DELIVERY_ERROR_CODES.leaseLost) {
    return { kind: 'lease_lost' };
  }
  if (
    code === DELIVERY_ERROR_CODES.materializationPrivate ||
    code === DELIVERY_ERROR_CODES.materializationDisabled ||
    code === DELIVERY_ERROR_CODES.materializationRepresentation
  ) {
    return { kind: 'terminal_failed', code };
  }
  if (input.attemptCount >= DISPATCHER_MAX_ATTEMPTS) {
    return {
      kind: 'retry_exhausted',
      code: DELIVERY_ERROR_CODES.materializationRetryExhausted,
    };
  }
  return {
    kind: 'retry_pending',
    code,
    delayMs: resolveRetryDelayMs({ attemptCount: input.attemptCount }),
  };
}

type MaterializationReportRow = {
  readonly reportId: string;
  readonly title: string;
  readonly publicSummary: string;
  readonly publishedAt: Date;
  readonly isPublic: boolean;
  readonly visibility: 'public' | 'private';
  readonly projectSlug: string;
};

type MaterializationActorRow = {
  readonly id: string;
  readonly kind: 'project' | 'aggregate';
  readonly preferredUsername: string;
  readonly enabled: boolean;
};

/**
 * Runs one bounded ActivityPub dispatcher pass: alternates materializing due outbound activities
 * with delivering queued inbox/outbox messages without starting a queue consumer.
 */
export async function runActivityPubDispatcherOnce(
  input: RunActivityPubDispatcherOnceInput,
): Promise<ActivityPubDispatcherRunResult> {
  const clock = input.clock ?? { now: () => new Date() };
  const deadline = clock.now().getTime() + (input.maxRuntimeMs ?? DISPATCHER_MAX_RUNTIME_MS);
  const maxBatch = input.maxBatchSize ?? DISPATCHER_DEFAULT_BATCH_SIZE;
  let activitiesMaterialized = 0;
  let queueProcessed = 0;
  let queueNoOps = 0;
  let processedInbox = 0;
  let processedOutbox = 0;
  let totalProcessed = 0;

  while (totalProcessed < maxBatch && clock.now().getTime() < deadline) {
    const preferActivity = activitiesMaterialized <= queueProcessed;
    if (preferActivity) {
      const materialized = await materializeOneDueActivity({
        sql: input.sql,
        canonicalOrigin: input.canonicalOrigin,
        encryptionKey: input.encryptionKey,
        clock,
      });
      if (materialized) {
        activitiesMaterialized += 1;
        totalProcessed += 1;
        continue;
      }
    }

    const preferredKind = selectNextQueueKind({ processedInbox, processedOutbox });
    const queueResult = await processOneQueuedMessage({
      sql: input.sql,
      canonicalOrigin: input.canonicalOrigin,
      encryptionKey: input.encryptionKey,
      actorRepository: input.actorRepository,
      isDomainBlocked: input.isDomainBlocked,
      testOnlyAllowPrivateAddress: input.testOnlyAllowPrivateAddress,
      testRemoteActorResolver: input.testRemoteActorResolver,
      testRemoteArticleResolver: input.testRemoteArticleResolver,
      testDocumentLoaderFactory: input.testDocumentLoaderFactory,
      testDeliveryFetchTimeoutMs: input.testDeliveryFetchTimeoutMs,
      preferredQueueKind: preferredKind,
      clock,
    });
    if (queueResult.status === 'processed' || queueResult.status === 'delivery_failed') {
      queueProcessed += 1;
      totalProcessed += 1;
      if (queueResult.queueKind === 'inbox') {
        processedInbox += 1;
      } else {
        processedOutbox += 1;
      }
      continue;
    }

    if (!preferActivity) {
      const materialized = await materializeOneDueActivity({
        sql: input.sql,
        canonicalOrigin: input.canonicalOrigin,
        encryptionKey: input.encryptionKey,
        clock,
      });
      if (materialized) {
        activitiesMaterialized += 1;
        totalProcessed += 1;
        continue;
      }
    }

    queueNoOps += 1;
    break;
  }

  return {
    status: clock.now().getTime() >= deadline ? 'deadline' : 'completed',
    activitiesMaterialized,
    queueProcessed,
    queueNoOps,
  };
}

/**
 * Claims one due outbound activity in a committed transaction, then materializes deliveries
 * in a separate lease-guarded transaction so crash recovery can reclaim expired claims.
 * Actor lookups and key decryption during materialization use a transaction-bound repository
 * so a single-connection pool is not deadlocked by nested connection requests.
 */
async function materializeOneDueActivity(input: {
  readonly sql: postgres.Sql;
  readonly canonicalOrigin: string;
  readonly encryptionKey: Buffer;
  readonly clock: ActivityPubDispatcherClock;
}): Promise<boolean> {
  const claimed = await claimDueActivity(input);
  if (!claimed) {
    return false;
  }
  try {
    await completeActivityMaterialization({
      sql: input.sql,
      canonicalOrigin: input.canonicalOrigin,
      encryptionKey: input.encryptionKey,
      clock: input.clock,
      claimed,
    });
    return true;
  } catch (error) {
    await failActivityMaterialization({
      sql: input.sql,
      clock: input.clock,
      claimed,
      error,
    });
    return true;
  }
}

async function claimDueActivity(input: {
  readonly sql: postgres.Sql;
  readonly clock: ActivityPubDispatcherClock;
}): Promise<ClaimedActivity | null> {
  return input.sql.begin(async (transaction) => {
    await recoverExpiredActivityLeases(transaction, input.clock);
    const rows = (await transaction`
      SELECT *
      FROM public.activitypub_activities
      WHERE direction = 'outbound'
        AND processing_status = 'pending'
        AND available_at <= ${input.clock.now()}
      ORDER BY available_at ASC, occurred_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `) as readonly unknown[];
    const activity = rows[0] ? parseActivityPubActivityRow(rows[0]) : undefined;
    if (!activity) {
      return null;
    }
    const workerToken = randomUUID();
    const leaseExpiresAt = new Date(input.clock.now().getTime() + DISPATCHER_LEASE_MS);
    const claimedRows = (await transaction`
      UPDATE public.activitypub_activities
      SET processing_status = 'running',
          worker_token = ${workerToken},
          lease_expires_at = ${leaseExpiresAt},
          started_at = COALESCE(started_at, ${input.clock.now()}),
          attempt_count = attempt_count + 1
      WHERE id = ${activity.id}::uuid
        AND processing_status = 'pending'
      RETURNING attempt_count
    `) as readonly unknown[];
    if (claimedRows.length === 0) {
      return null;
    }
    const attemptCount = parseClaimedAttemptCount(claimedRows[0]);
    return {
      id: activity.id,
      workerToken,
      attemptCount,
      activity: { ...activity, attemptCount },
    };
  });
}

async function completeActivityMaterialization(input: {
  readonly sql: postgres.Sql;
  readonly canonicalOrigin: string;
  readonly encryptionKey: Buffer;
  readonly clock: ActivityPubDispatcherClock;
  readonly claimed: ClaimedActivity;
}): Promise<void> {
  await input.sql.begin(async (transaction) => {
    const leaseRows = (await transaction`
      SELECT id
      FROM public.activitypub_activities
      WHERE id = ${input.claimed.id}::uuid
        AND worker_token = ${input.claimed.workerToken}
        AND processing_status = 'running'
        AND lease_expires_at > ${input.clock.now()}
      FOR UPDATE
    `) as readonly unknown[];
    if (leaseRows.length === 0) {
      throw new Error(DELIVERY_ERROR_CODES.leaseLost);
    }
    const actorRepository = createPostgresActivityPubTransactionRepository({
      sql: transaction,
      encryptionKey: input.encryptionKey,
    });
    await materializeActivityDeliveries({
      sql: transaction,
      canonicalOrigin: input.canonicalOrigin,
      actorRepository,
      activity: input.claimed.activity,
      clock: input.clock,
    });
    const finalized = await transaction`
      UPDATE public.activitypub_activities
      SET processing_status = 'processed',
          worker_token = NULL,
          lease_expires_at = NULL,
          processed_at = ${input.clock.now()}
      WHERE id = ${input.claimed.id}::uuid
        AND worker_token = ${input.claimed.workerToken}
        AND processing_status = 'running'
        AND lease_expires_at > ${input.clock.now()}
    `;
    if (finalized.count === 0) {
      throw new Error(DELIVERY_ERROR_CODES.leaseLost);
    }
  });
}

/**
 * Applies lease-aware failure handling for a claimed outbound activity row.
 * Exported for deterministic DB fixture tests that assert retry and lease semantics directly.
 */
export async function failActivityMaterialization(input: {
  readonly sql: postgres.Sql;
  readonly clock: ActivityPubDispatcherClock;
  readonly claimed: ClaimedActivity;
  readonly error: unknown;
}): Promise<void> {
  const decision = classifyMaterializationFailure({
    attemptCount: input.claimed.attemptCount,
    error: input.error,
  });
  if (decision.kind === 'lease_lost') {
    return;
  }
  const now = input.clock.now();
  if (decision.kind === 'retry_pending') {
    await input.sql`
      UPDATE public.activitypub_activities
      SET processing_status = 'pending',
          worker_token = NULL,
          lease_expires_at = NULL,
          available_at = ${new Date(now.getTime() + decision.delayMs)},
          last_error_code = ${decision.code}
      WHERE id = ${input.claimed.id}::uuid
        AND worker_token = ${input.claimed.workerToken}
        AND processing_status = 'running'
        AND lease_expires_at > ${now}
    `;
  } else {
    await input.sql`
      UPDATE public.activitypub_activities
      SET processing_status = 'failed',
          worker_token = NULL,
          lease_expires_at = NULL,
          last_error_code = ${decision.code}
      WHERE id = ${input.claimed.id}::uuid
        AND worker_token = ${input.claimed.workerToken}
        AND processing_status = 'running'
        AND lease_expires_at > ${now}
    `;
  }
}

function parseClaimedAttemptCount(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid claimed activity attempt_count row.');
  }
  const attemptCount = Reflect.get(value, 'attempt_count');
  if (typeof attemptCount !== 'number' || !Number.isInteger(attemptCount) || attemptCount < 0) {
    throw new Error('Invalid claimed activity attempt_count.');
  }
  return attemptCount;
}

function resolveMaterializationErrorCode(error: unknown): DeliveryErrorCode {
  if (error instanceof Error) {
    if (
      error.message === DELIVERY_ERROR_CODES.materializationPrivate ||
      error.message === DELIVERY_ERROR_CODES.materializationDisabled ||
      error.message === DELIVERY_ERROR_CODES.materializationRepresentation ||
      error.message === DELIVERY_ERROR_CODES.leaseLost
    ) {
      return error.message;
    }
  }
  return DELIVERY_ERROR_CODES.unknownDeliveryError;
}

async function recoverExpiredActivityLeases(
  sql: postgres.Sql | postgres.TransactionSql,
  clock: ActivityPubDispatcherClock,
): Promise<void> {
  await sql`
    UPDATE public.activitypub_activities
    SET processing_status = 'pending',
        worker_token = NULL,
        lease_expires_at = NULL,
        available_at = ${clock.now()}
    WHERE direction = 'outbound'
      AND processing_status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= ${clock.now()}
  `;
}

/** Materializes signed outbox queue rows for one claimed outbound activity. */
export async function materializeActivityDeliveries(input: {
  readonly sql: postgres.Sql | postgres.TransactionSql;
  readonly canonicalOrigin: string;
  readonly actorRepository: ActivityPubRepository;
  readonly activity: ReturnType<typeof parseActivityPubActivityRow>;
  readonly clock: ActivityPubDispatcherClock;
}): Promise<void> {
  const payload = parseReportActivityPayload(input.activity.payloadJson);
  const reportRows = (await input.sql`
    SELECT
      r.id::text AS report_id,
      r.title,
      r.activitypub_published_at,
      r.activitypub_public_summary,
      r.is_public,
      p.slug AS project_slug,
      COALESCE(p.visibility, 'private') AS visibility
    FROM public.reports r
    JOIN public.projects p ON p.id = r.project_id
    WHERE r.id = ${payload.reportId}::uuid
    LIMIT 1
  `) as readonly unknown[];
  if (reportRows.length === 0) {
    throw new Error(DELIVERY_ERROR_CODES.materializationPrivate);
  }
  const report = parseMaterializationReportRow(reportRows[0]);
  if (!report.isPublic || report.visibility !== 'public') {
    throw new Error(DELIVERY_ERROR_CODES.materializationPrivate);
  }

  const configRows = (await input.sql`
    SELECT object_representation
    FROM public.activitypub_instance_config
    WHERE id = 1
    LIMIT 1
  `) as readonly unknown[];
  const representation = parseInstanceRepresentation(configRows[0]);
  if (representation !== payload.objectRepresentation) {
    throw new Error(DELIVERY_ERROR_CODES.materializationRepresentation);
  }

  const createActivityUri = buildStableCreateActivityUri({
    canonicalOrigin: input.canonicalOrigin,
    reportId: payload.reportId,
  });
  const announceActivityUri = buildStableAnnounceActivityUri({
    canonicalOrigin: input.canonicalOrigin,
    reportId: payload.reportId,
  });
  const isCreateActivity = input.activity.activityUri === createActivityUri;
  const isAnnounceActivity = input.activity.activityUri === announceActivityUri;
  if (!isCreateActivity && !isAnnounceActivity) {
    throw new Error(DELIVERY_ERROR_CODES.materializationRepresentation);
  }

  const actorRows = (await input.sql`
    SELECT a.id::text AS id, a.kind, a.preferred_username, a.enabled
    FROM public.activitypub_actors a
    WHERE a.enabled = true
      AND (
        (a.kind = 'project' AND a.project_id = (
          SELECT project_id FROM public.reports WHERE id = ${payload.reportId}::uuid
        ))
        OR a.kind = 'aggregate'
      )
  `) as readonly unknown[];

  const projectActor = actorRows
    .map(parseMaterializationActorRow)
    .find((row) => row.kind === 'project');
  const aggregateActor = actorRows
    .map(parseMaterializationActorRow)
    .find((row) => row.kind === 'aggregate');
  if (isCreateActivity && !projectActor) {
    throw new Error(DELIVERY_ERROR_CODES.materializationDisabled);
  }
  if (isAnnounceActivity && !aggregateActor) {
    throw new Error(DELIVERY_ERROR_CODES.materializationDisabled);
  }
  if (!projectActor && !aggregateActor) {
    throw new Error(DELIVERY_ERROR_CODES.materializationDisabled);
  }

  const projectFollowers = projectActor ? await loadFollowAudience(input.sql, projectActor.id) : [];
  const aggregateFollowers = aggregateActor
    ? await loadFollowAudience(input.sql, aggregateActor.id)
    : [];
  const uri = buildActivityPubUriContract(input.canonicalOrigin);
  const objectUri = input.activity.objectUri ?? '';
  const expectedObjectUri = uri.reportArticleUrl(payload.reportId);
  if (objectUri !== expectedObjectUri) {
    throw new Error(DELIVERY_ERROR_CODES.materializationRepresentation);
  }
  const fallbackActorId = projectActor?.id ?? aggregateActor?.id;
  if (!fallbackActorId) {
    throw new Error(DELIVERY_ERROR_CODES.materializationDisabled);
  }
  const recipients = dedupeRecipients(
    reconstructReportDeliveryRecipients({
      publicationOccurredAt: input.activity.occurredAt,
      projectActorId: projectActor?.id ?? fallbackActorId,
      aggregateActorId: aggregateActor?.id ?? fallbackActorId,
      createActivityUri,
      announceActivityUri,
      objectUri,
      projectFollowers,
      aggregateFollowers,
    }),
  );

  const queue = createPostgresQueueAdapter({
    sql: input.sql,
    canonicalOrigin: input.canonicalOrigin,
  });
  const actorMaterializationCache = new Map<
    string,
    Awaited<ReturnType<typeof loadActorMaterialization>>
  >();

  for (const recipient of recipients) {
    if (recipient.activityUri !== input.activity.activityUri) {
      continue;
    }
    if (recipient.activityType === 'Create') {
      if (!projectActor) {
        throw new Error(DELIVERY_ERROR_CODES.materializationDisabled);
      }
      const preferredUsername = projectActor.preferredUsername;
      let actorMaterialization = actorMaterializationCache.get(preferredUsername);
      if (!actorMaterialization) {
        actorMaterialization = await loadActorMaterialization(
          input.actorRepository,
          preferredUsername,
        );
        actorMaterializationCache.set(preferredUsername, actorMaterialization);
      }
      const activityJson = buildCreateActivityJsonLd({
        canonicalOrigin: input.canonicalOrigin,
        reportId: payload.reportId,
        projectSlug: report.projectSlug,
        title: report.title,
        publicSummary: report.publicSummary,
        publishedAt: report.publishedAt,
        objectRepresentation: representation,
        projectPreferredUsername: projectActor.preferredUsername,
        aggregatePreferredUsername:
          aggregateActor?.preferredUsername ?? projectActor.preferredUsername,
        activityUri: recipient.activityUri,
      });
      const dedupeKey = buildOutboxDedupeKey({
        activityId: recipient.activityUri,
        recipientInbox: recipient.inboxUri,
      });
      await queue.enqueue(
        {
          type: 'outbox',
          id: randomUUID(),
          baseUrl: uri.canonicalOrigin,
          keys: [
            {
              keyId: uri.actorKeyId(preferredUsername),
              privateKey: actorMaterialization.privateJwk,
            },
          ],
          activity: activityJson,
          activityId: recipient.activityUri,
          activityType: recipient.activityType,
          inbox: recipient.inboxUri,
          sharedInbox: recipient.sharedInbox,
          actorIds: [uri.actorUrl(preferredUsername)],
          started: input.clock.now().toISOString(),
          attempt: 0,
          headers: {},
          orderingKey: recipient.orderingKey,
          traceContext: {},
        },
        { dedupeKey, orderingKey: recipient.orderingKey },
      );
      continue;
    }

    if (!aggregateActor) {
      throw new Error(DELIVERY_ERROR_CODES.materializationDisabled);
    }
    const preferredUsername = aggregateActor.preferredUsername;
    let actorMaterialization = actorMaterializationCache.get(preferredUsername);
    if (!actorMaterialization) {
      actorMaterialization = await loadActorMaterialization(
        input.actorRepository,
        preferredUsername,
      );
      actorMaterializationCache.set(preferredUsername, actorMaterialization);
    }
    const activityJson = buildAnnounceActivityJsonLd({
      canonicalOrigin: input.canonicalOrigin,
      activityUri: recipient.activityUri,
      objectUri,
      publishedAt: report.publishedAt,
      aggregatePreferredUsername: aggregateActor.preferredUsername,
    });
    const dedupeKey = buildOutboxDedupeKey({
      activityId: recipient.activityUri,
      recipientInbox: recipient.inboxUri,
    });
    await queue.enqueue(
      {
        type: 'outbox',
        id: randomUUID(),
        baseUrl: uri.canonicalOrigin,
        keys: [
          {
            keyId: uri.actorKeyId(preferredUsername),
            privateKey: actorMaterialization.privateJwk,
          },
        ],
        activity: activityJson,
        activityId: recipient.activityUri,
        activityType: recipient.activityType,
        inbox: recipient.inboxUri,
        sharedInbox: recipient.sharedInbox,
        actorIds: [uri.actorUrl(preferredUsername)],
        started: input.clock.now().toISOString(),
        attempt: 0,
        headers: {},
        orderingKey: recipient.orderingKey,
        traceContext: {},
      },
      { dedupeKey, orderingKey: recipient.orderingKey },
    );
  }
}

async function loadActorMaterialization(
  actorRepository: ActivityPubRepository,
  preferredUsername: string,
): Promise<{ readonly privateJwk: Awaited<ReturnType<typeof exportJwk>> }> {
  const actor = await actorRepository.findRemotelyVisibleActorByUsername(preferredUsername);
  if (!actor) {
    throw new Error(DELIVERY_ERROR_CODES.materializationDisabled);
  }
  const keyPair = await actorRepository.importActorCryptoKeyPair(actor.id);
  const privateJwk = await exportJwk(keyPair.privateKey);
  return { privateJwk };
}

function parseMaterializationReportRow(value: unknown): MaterializationReportRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid materialization report row.');
  }
  const row = value as Record<string, unknown>;
  const reportId = row.report_id;
  const title = row.title;
  const publicSummary = row.activitypub_public_summary;
  const publishedAt = row.activitypub_published_at;
  const isPublic = row.is_public;
  const visibility = row.visibility;
  const projectSlug = row.project_slug;
  if (typeof reportId !== 'string' || reportId.length === 0) {
    throw new Error('Invalid materialization report row report_id.');
  }
  if (typeof title !== 'string' || title.length === 0) {
    throw new Error('Invalid materialization report row title.');
  }
  if (typeof publicSummary !== 'string') {
    throw new Error('Invalid materialization report row activitypub_public_summary.');
  }
  if (!(publishedAt instanceof Date) && typeof publishedAt !== 'string') {
    throw new Error('Invalid materialization report row activitypub_published_at.');
  }
  const parsedPublishedAt = publishedAt instanceof Date ? publishedAt : new Date(publishedAt);
  if (Number.isNaN(parsedPublishedAt.getTime())) {
    throw new Error('Invalid materialization report row activitypub_published_at.');
  }
  if (typeof isPublic !== 'boolean') {
    throw new Error('Invalid materialization report row is_public.');
  }
  if (visibility !== 'public' && visibility !== 'private') {
    throw new Error('Invalid materialization report row visibility.');
  }
  if (typeof projectSlug !== 'string' || projectSlug.length === 0) {
    throw new Error('Invalid materialization report row project_slug.');
  }
  return {
    reportId,
    title,
    publicSummary,
    publishedAt: parsedPublishedAt,
    isPublic,
    visibility,
    projectSlug,
  };
}

function parseMaterializationActorRow(value: unknown): MaterializationActorRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid materialization actor row.');
  }
  const row = value as Record<string, unknown>;
  const id = row.id;
  const kind = row.kind;
  const preferredUsername = row.preferred_username;
  const enabled = row.enabled;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Invalid materialization actor row id.');
  }
  if (kind !== 'project' && kind !== 'aggregate') {
    throw new Error('Invalid materialization actor row kind.');
  }
  if (typeof preferredUsername !== 'string' || preferredUsername.length === 0) {
    throw new Error('Invalid materialization actor row preferred_username.');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('Invalid materialization actor row enabled.');
  }
  return { id, kind, preferredUsername, enabled };
}

function parseInstanceRepresentation(value: unknown): 'article' | 'note' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid instance config row.');
  }
  const representation = Reflect.get(value, 'object_representation');
  if (representation !== 'article' && representation !== 'note') {
    throw new Error('Invalid instance config object_representation.');
  }
  return representation;
}

function parseFollowAudienceRow(value: unknown): FollowAudienceRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid follow audience row.');
  }
  const row = value as Record<string, unknown>;
  const remoteActorUri = row.remote_actor_uri;
  const remoteInboxUri = row.remote_inbox_uri;
  const remoteSharedInboxUri = row.remote_shared_inbox_uri;
  const acceptedAt = row.accepted_at;
  const undoneAt = row.undone_at;
  if (typeof remoteActorUri !== 'string' || remoteActorUri.length === 0) {
    throw new Error('Invalid follow audience row remote_actor_uri.');
  }
  if (typeof remoteInboxUri !== 'string' || remoteInboxUri.length === 0) {
    throw new Error('Invalid follow audience row remote_inbox_uri.');
  }
  if (
    remoteSharedInboxUri !== null &&
    (typeof remoteSharedInboxUri !== 'string' || remoteSharedInboxUri.length === 0)
  ) {
    throw new Error('Invalid follow audience row remote_shared_inbox_uri.');
  }
  if (!(acceptedAt instanceof Date) && typeof acceptedAt !== 'string') {
    throw new Error('Invalid follow audience row accepted_at.');
  }
  const parsedAcceptedAt = acceptedAt instanceof Date ? acceptedAt : new Date(acceptedAt);
  if (Number.isNaN(parsedAcceptedAt.getTime())) {
    throw new Error('Invalid follow audience row accepted_at.');
  }
  let parsedUndoneAt: Date | null = null;
  if (undoneAt !== null && undoneAt !== undefined) {
    if (!(undoneAt instanceof Date) && typeof undoneAt !== 'string') {
      throw new Error('Invalid follow audience row undone_at.');
    }
    parsedUndoneAt = undoneAt instanceof Date ? undoneAt : new Date(undoneAt);
    if (Number.isNaN(parsedUndoneAt.getTime())) {
      throw new Error('Invalid follow audience row undone_at.');
    }
  }
  return {
    remoteActorUri,
    remoteInboxUri,
    remoteSharedInboxUri: remoteSharedInboxUri === null ? null : (remoteSharedInboxUri as string),
    acceptedAt: parsedAcceptedAt,
    undoneAt: parsedUndoneAt,
  };
}

async function loadFollowAudience(
  sql: postgres.Sql | postgres.TransactionSql,
  localActorId: string,
): Promise<readonly FollowAudienceRow[]> {
  const rows = (await sql`
    SELECT
      remote_actor_uri,
      remote_inbox_uri,
      remote_shared_inbox_uri,
      accepted_at,
      undone_at
    FROM public.activitypub_follows
    WHERE local_actor_id = ${localActorId}::uuid
      AND direction = 'inbound'
      AND accepted_at IS NOT NULL
  `) as readonly unknown[];
  return rows.map(parseFollowAudienceRow);
}

export { createPostgresFedifyKvStore };
