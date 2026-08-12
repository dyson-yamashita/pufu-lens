import type postgres from 'postgres';
import { type DeliveryErrorCode, isDeliveryErrorCode } from './delivery-errors.ts';
import { type ActivityPubQueueKind, type ActivityPubQueueStatus, readSqlRows } from './schema.ts';

/** Structured log event name for bodyless ActivityPub queue metrics. */
export const ACTIVITYPUB_QUEUE_METRICS_EVENT = 'activitypub_queue_metrics';

/** Structured log event name for per-origin ActivityPub failure metrics. */
export const ACTIVITYPUB_ORIGIN_FAILURE_METRICS_EVENT = 'activitypub_origin_failure_metrics';

/** Schema version for ActivityPub operations snapshot and metrics events. */
export const ACTIVITYPUB_OPERATIONS_SCHEMA_VERSION = 1;

/** Rolling window length in hours for ActivityPub operations counters. */
export const ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS = 24;

/** Maximum number of origin failure summaries emitted before aggregating into `other`. */
export const ACTIVITYPUB_ORIGIN_FAILURE_TOP_N = 20;

/** Maximum length for operator `change_ref` audit values. */
export const ACTIVITYPUB_QUEUE_ADMIN_CHANGE_REF_MAX_LENGTH = 72;

/** Operational reference pattern for queue admin audit rows and CLI input. */
export const ACTIVITYPUB_QUEUE_ADMIN_CHANGE_REF_PATTERN =
  /^(issue|pr|change|incident|ticket)-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Canonical UTC ISO-8601 timestamp pattern accepted by queue admin tooling. */
export const ACTIVITYPUB_QUEUE_ADMIN_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Fixed label used when aggregating origin failure summaries beyond the top-N cap. */
export const ACTIVITYPUB_ORIGIN_FAILURE_OTHER_LABEL = 'other';

const ACTIVITYPUB_BUSINESS_TABLES = [
  'activitypub_fedify_kv',
  'activitypub_queue_messages',
  'activitypub_instance_config',
  'activitypub_actors',
  'activitypub_follows',
  'activitypub_activities',
  'federated_reports',
  'activitypub_queue_operator_actions',
] as const;

const QUEUE_ADMIN_ACTIONS = ['requeue', 'discard'] as const;

export type ActivityPubQueueOperatorAction = (typeof QUEUE_ADMIN_ACTIONS)[number];

/** Returns whether a queue admin change reference matches the operational allowlist. */
export function isValidActivityPubQueueAdminChangeRef(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= ACTIVITYPUB_QUEUE_ADMIN_CHANGE_REF_MAX_LENGTH &&
    ACTIVITYPUB_QUEUE_ADMIN_CHANGE_REF_PATTERN.test(value)
  );
}

/** Parses a canonical UTC ISO timestamp that round-trips through `Date.toISOString()`. */
export function parseCanonicalActivityPubQueueAdminTimestamp(value: string): Date | undefined {
  if (!ACTIVITYPUB_QUEUE_ADMIN_UTC_TIMESTAMP_PATTERN.test(value)) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return undefined;
  }
  return parsed;
}

/** Bodyless queue depth grouped by active backlog statuses. */
export type ActivityPubQueueDepthByStatus = {
  readonly pending: number;
  readonly running: number;
  readonly retryWait: number;
};

/** Safe per-origin outbox failure counters within the rolling window used for observability. */
export type ActivityPubOriginFailureSummary = {
  readonly origin: string;
  readonly retryCount: number;
  readonly retryExhaustedCount: number;
  readonly permanentFailureCount: number;
  readonly http429Count: number;
  readonly http5xxCount: number;
};

/** Bodyless ActivityPub queue and table snapshot for operators and metrics. */
export type ActivityPubOperationsSnapshot = {
  readonly schemaVersion: typeof ACTIVITYPUB_OPERATIONS_SCHEMA_VERSION;
  readonly windowHours: typeof ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS;
  readonly queueDepth: ActivityPubQueueDepthByStatus;
  readonly oldestBacklogAgeSeconds: number | null;
  readonly succeededInWindow: number;
  readonly retryWaitCurrentCount: number;
  readonly retryExhaustedCurrentCount: number;
  readonly retryExhaustedInWindow: number;
  readonly permanentFailuresInWindow: number;
  readonly http429FailuresInWindow: number;
  readonly http5xxFailuresInWindow: number;
  readonly totalBusinessTableBytes: number;
  readonly originFailureSummaries: readonly ActivityPubOriginFailureSummary[];
};

/** Safe queue message metadata exposed to operator inspect tooling. */
export type ActivityPubQueueInspectView = {
  readonly id: string;
  readonly queueKind: ActivityPubQueueKind;
  readonly recipientOrigin: string | null;
  readonly status: ActivityPubQueueStatus;
  readonly attemptCount: number;
  readonly lastErrorCode: DeliveryErrorCode | null;
  readonly lastHttpStatus: number | null;
  readonly availableAt: Date;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly updatedAt: Date;
};

export type ActivityPubQueueAdminMutationInput = {
  readonly messageId: string;
  readonly expectedUpdatedAt: Date;
  readonly changeRef: string;
};

export type ActivityPubQueueAdminMutationResult =
  | {
      readonly status: 'updated';
      readonly action: ActivityPubQueueOperatorAction;
      readonly auditActionId: string;
      readonly message: ActivityPubQueueInspectView;
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'stale_state' }
  | { readonly status: 'invalid_status'; readonly currentStatus: ActivityPubQueueStatus }
  | { readonly status: 'active_lease' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ActivityPub operations row field: ${fieldName}`);
  }
  return value;
}

function parseNullableString(value: unknown, fieldName: string): string | null {
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid ActivityPub operations row field: ${fieldName}`);
}

function parseRequiredInteger(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  throw new Error(`Invalid ActivityPub operations row field: ${fieldName}`);
}

function parseNullableInteger(value: unknown, fieldName: string): number | null {
  if (value === null) {
    return null;
  }
  return parseRequiredInteger(value, fieldName);
}

function parseRequiredDate(value: unknown, fieldName: string): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new Error(`Invalid ActivityPub operations row field: ${fieldName}`);
}

function parseNullableDate(value: unknown, fieldName: string): Date | null {
  if (value === null) {
    return null;
  }
  return parseRequiredDate(value, fieldName);
}

function parseQueueKind(value: unknown): ActivityPubQueueKind {
  const kind = parseRequiredString(value, 'queue_kind');
  if (kind === 'inbox' || kind === 'outbox') {
    return kind;
  }
  throw new Error('Invalid ActivityPub operations row field: queue_kind');
}

function parseQueueStatus(value: unknown): ActivityPubQueueStatus {
  const status = parseRequiredString(value, 'status');
  if (
    status === 'pending' ||
    status === 'running' ||
    status === 'retry_wait' ||
    status === 'succeeded' ||
    status === 'retry_exhausted' ||
    status === 'permanent_failure'
  ) {
    return status;
  }
  throw new Error('Invalid ActivityPub operations row field: status');
}

function parseRequiredBoolean(value: unknown, fieldName: string): boolean {
  if (value === true || value === false) {
    return value;
  }
  throw new Error(`Invalid ActivityPub operations row field: ${fieldName}`);
}

function parseNullableDeliveryErrorCode(
  value: unknown,
  fieldName: string,
): DeliveryErrorCode | null {
  if (value === null) {
    return null;
  }
  if (isDeliveryErrorCode(value)) {
    return value;
  }
  throw new Error(`Invalid ActivityPub operations row field: ${fieldName}`);
}

function parseQueueInspectRow(row: unknown): ActivityPubQueueInspectView {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub queue inspect row.');
  }
  return {
    id: parseRequiredString(row.id, 'id'),
    queueKind: parseQueueKind(row.queue_kind),
    recipientOrigin: parseNullableString(row.recipient_origin, 'recipient_origin'),
    status: parseQueueStatus(row.status),
    attemptCount: parseRequiredInteger(row.attempt_count, 'attempt_count'),
    lastErrorCode: parseNullableDeliveryErrorCode(row.last_error_code, 'last_error_code'),
    lastHttpStatus: parseNullableInteger(row.last_http_status, 'last_http_status'),
    availableAt: parseRequiredDate(row.available_at, 'available_at'),
    createdAt: parseRequiredDate(row.created_at, 'created_at'),
    startedAt: parseNullableDate(row.started_at, 'started_at'),
    completedAt: parseNullableDate(row.completed_at, 'completed_at'),
    updatedAt: parseRequiredDate(row.updated_at, 'updated_at'),
  };
}

function parseQueueDepthRow(row: unknown): { status: ActivityPubQueueStatus; count: number } {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub queue depth row.');
  }
  return {
    status: parseQueueStatus(row.status),
    count: parseRequiredInteger(row.count, 'count'),
  };
}

function parseWindowAggregateRow(row: unknown): {
  succeededInWindow: number;
  retryWaitCurrentCount: number;
  retryExhaustedCurrentCount: number;
  retryExhaustedInWindow: number;
  permanentFailuresInWindow: number;
  http429FailuresInWindow: number;
  http5xxFailuresInWindow: number;
} {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub queue window aggregate row.');
  }
  return {
    succeededInWindow: parseRequiredInteger(row.succeeded_in_window, 'succeeded_in_window'),
    retryWaitCurrentCount: parseRequiredInteger(
      row.retry_wait_current_count,
      'retry_wait_current_count',
    ),
    retryExhaustedCurrentCount: parseRequiredInteger(
      row.retry_exhausted_current_count,
      'retry_exhausted_current_count',
    ),
    retryExhaustedInWindow: parseRequiredInteger(
      row.retry_exhausted_in_window,
      'retry_exhausted_in_window',
    ),
    permanentFailuresInWindow: parseRequiredInteger(
      row.permanent_failures_in_window,
      'permanent_failures_in_window',
    ),
    http429FailuresInWindow: parseRequiredInteger(
      row.http_429_failures_in_window,
      'http_429_failures_in_window',
    ),
    http5xxFailuresInWindow: parseRequiredInteger(
      row.http_5xx_failures_in_window,
      'http_5xx_failures_in_window',
    ),
  };
}

function parseOldestBacklogAgeRow(row: unknown): number | null {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub oldest backlog age row.');
  }
  const value = row.oldest_backlog_age_seconds;
  if (value === null) {
    return null;
  }
  return parseRequiredInteger(value, 'oldest_backlog_age_seconds');
}

function parseTotalBytesRow(row: unknown): number {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub total bytes row.');
  }
  return parseRequiredInteger(row.total_business_table_bytes, 'total_business_table_bytes');
}

function parseOriginFailureRow(row: unknown): ActivityPubOriginFailureSummary {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub origin failure row.');
  }
  return {
    origin: parseRequiredString(row.origin, 'origin'),
    retryCount: parseRequiredInteger(row.retry_count, 'retry_count'),
    retryExhaustedCount: parseRequiredInteger(row.retry_exhausted_count, 'retry_exhausted_count'),
    permanentFailureCount: parseRequiredInteger(
      row.permanent_failure_count,
      'permanent_failure_count',
    ),
    http429Count: parseRequiredInteger(row.http_429_count, 'http_429_count'),
    http5xxCount: parseRequiredInteger(row.http_5xx_count, 'http_5xx_count'),
  };
}

function emptyQueueDepth(): ActivityPubQueueDepthByStatus {
  return { pending: 0, running: 0, retryWait: 0 };
}

function applyQueueDepth(
  depth: ActivityPubQueueDepthByStatus,
  status: ActivityPubQueueStatus,
  count: number,
): ActivityPubQueueDepthByStatus {
  switch (status) {
    case 'pending':
      return { ...depth, pending: count };
    case 'running':
      return { ...depth, running: count };
    case 'retry_wait':
      return { ...depth, retryWait: count };
    default:
      return depth;
  }
}

function originFailureVolume(summary: ActivityPubOriginFailureSummary): number {
  return (
    summary.retryCount +
    summary.retryExhaustedCount +
    summary.permanentFailureCount +
    summary.http429Count +
    summary.http5xxCount
  );
}

function aggregateOriginFailures(
  summaries: readonly ActivityPubOriginFailureSummary[],
): readonly ActivityPubOriginFailureSummary[] {
  const nonZero = summaries.filter((summary) => originFailureVolume(summary) > 0);
  if (nonZero.length <= ACTIVITYPUB_ORIGIN_FAILURE_TOP_N) {
    return nonZero;
  }

  const sorted = [...nonZero].sort((left, right) => {
    const volumeDelta = originFailureVolume(right) - originFailureVolume(left);
    if (volumeDelta !== 0) {
      return volumeDelta;
    }
    return left.origin.localeCompare(right.origin);
  });

  const top = sorted.slice(0, ACTIVITYPUB_ORIGIN_FAILURE_TOP_N);
  const rest = sorted.slice(ACTIVITYPUB_ORIGIN_FAILURE_TOP_N);
  const other = rest.reduce<ActivityPubOriginFailureSummary>(
    (accumulator, summary) => ({
      origin: ACTIVITYPUB_ORIGIN_FAILURE_OTHER_LABEL,
      retryCount: accumulator.retryCount + summary.retryCount,
      retryExhaustedCount: accumulator.retryExhaustedCount + summary.retryExhaustedCount,
      permanentFailureCount: accumulator.permanentFailureCount + summary.permanentFailureCount,
      http429Count: accumulator.http429Count + summary.http429Count,
      http5xxCount: accumulator.http5xxCount + summary.http5xxCount,
    }),
    {
      origin: ACTIVITYPUB_ORIGIN_FAILURE_OTHER_LABEL,
      retryCount: 0,
      retryExhaustedCount: 0,
      permanentFailureCount: 0,
      http429Count: 0,
      http5xxCount: 0,
    },
  );

  if (originFailureVolume(other) === 0) {
    return top;
  }
  return [...top, other];
}

/** Caps origin failure summaries to the top-N origins plus a fixed `other` aggregate. */
export function capActivityPubOriginFailureSummaries(
  summaries: readonly ActivityPubOriginFailureSummary[],
): readonly ActivityPubOriginFailureSummary[] {
  return aggregateOriginFailures(summaries);
}

function buildBusinessTableBytesQuery(): string {
  const terms = ACTIVITYPUB_BUSINESS_TABLES.map(
    (tableName) => `COALESCE(pg_total_relation_size(to_regclass('public.${tableName}')), 0)`,
  );
  return `SELECT (${terms.join(' + ')})::bigint AS total_business_table_bytes`;
}

/**
 * Reads a bodyless ActivityPub queue and storage snapshot for metrics and operator dashboards.
 * Never selects message payloads, signatures, credentials, or response bodies.
 */
export async function fetchActivityPubOperationsSnapshot(
  sql: postgres.Sql,
): Promise<ActivityPubOperationsSnapshot> {
  const depthRows = readSqlRows(
    await sql`
    SELECT status, COUNT(*)::bigint AS count
    FROM public.activitypub_queue_messages
    WHERE status IN ('pending', 'running', 'retry_wait')
    GROUP BY status
  `,
  );
  let queueDepth = emptyQueueDepth();
  for (const row of depthRows) {
    const parsed = parseQueueDepthRow(row);
    queueDepth = applyQueueDepth(queueDepth, parsed.status, parsed.count);
  }

  const oldestRows = readSqlRows(
    await sql`
    SELECT
      CASE
        WHEN COUNT(*) = 0 THEN NULL
        ELSE FLOOR(EXTRACT(EPOCH FROM (now() - MIN(created_at))))::bigint
      END AS oldest_backlog_age_seconds
    FROM public.activitypub_queue_messages
    WHERE status IN ('pending', 'running', 'retry_wait')
  `,
  );
  const oldestBacklogAgeSeconds = parseOldestBacklogAgeRow(oldestRows[0]);

  const windowRows = readSqlRows(
    await sql`
    SELECT
      COUNT(*) FILTER (
        WHERE status = 'succeeded'
          AND completed_at >= now() - make_interval(hours => ${ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS})
      )::bigint AS succeeded_in_window,
      COUNT(*) FILTER (WHERE status = 'retry_wait')::bigint AS retry_wait_current_count,
      COUNT(*) FILTER (WHERE status = 'retry_exhausted')::bigint AS retry_exhausted_current_count,
      COUNT(*) FILTER (
        WHERE status = 'retry_exhausted'
          AND updated_at >= now() - make_interval(hours => ${ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS})
      )::bigint AS retry_exhausted_in_window,
      COUNT(*) FILTER (
        WHERE status = 'permanent_failure'
          AND completed_at >= now() - make_interval(hours => ${ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS})
      )::bigint AS permanent_failures_in_window,
      COUNT(*) FILTER (
        WHERE last_error_code = 'http_429'
          AND updated_at >= now() - make_interval(hours => ${ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS})
      )::bigint AS http_429_failures_in_window,
      COUNT(*) FILTER (
        WHERE last_error_code = 'http_5xx'
          AND updated_at >= now() - make_interval(hours => ${ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS})
      )::bigint AS http_5xx_failures_in_window
    FROM public.activitypub_queue_messages
  `,
  );
  const windowAggregate = parseWindowAggregateRow(windowRows[0]);

  const totalBytesRows = readSqlRows(await sql.unsafe(buildBusinessTableBytesQuery()));
  const totalBusinessTableBytes = parseTotalBytesRow(totalBytesRows[0]);

  const originRows = readSqlRows(
    await sql`
    SELECT
      recipient_origin AS origin,
      COUNT(*) FILTER (
        WHERE status = 'retry_wait'
          AND updated_at >= now() - make_interval(hours => ${ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS})
      )::bigint AS retry_count,
      COUNT(*) FILTER (
        WHERE status = 'retry_exhausted'
          AND updated_at >= now() - make_interval(hours => ${ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS})
      )::bigint AS retry_exhausted_count,
      COUNT(*) FILTER (
        WHERE status = 'permanent_failure'
          AND completed_at >= now() - make_interval(hours => ${ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS})
      )::bigint AS permanent_failure_count,
      COUNT(*) FILTER (
        WHERE last_error_code = 'http_429'
          AND updated_at >= now() - make_interval(hours => ${ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS})
      )::bigint AS http_429_count,
      COUNT(*) FILTER (
        WHERE last_error_code = 'http_5xx'
          AND updated_at >= now() - make_interval(hours => ${ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS})
      )::bigint AS http_5xx_count
    FROM public.activitypub_queue_messages
    WHERE queue_kind = 'outbox'
      AND recipient_origin IS NOT NULL
    GROUP BY recipient_origin
  `,
  );
  const originFailureSummaries = aggregateOriginFailures(
    originRows.map((row) => parseOriginFailureRow(row)),
  );

  return {
    schemaVersion: ACTIVITYPUB_OPERATIONS_SCHEMA_VERSION,
    windowHours: ACTIVITYPUB_OPERATIONS_SNAPSHOT_WINDOW_HOURS,
    queueDepth,
    oldestBacklogAgeSeconds,
    ...windowAggregate,
    totalBusinessTableBytes,
    originFailureSummaries,
  };
}

/**
 * Returns safe queue metadata for a single message without selecting payloads or dedupe keys.
 */
export async function inspectActivityPubQueueMessage(
  sql: postgres.Sql,
  messageId: string,
): Promise<ActivityPubQueueInspectView | undefined> {
  const rows = readSqlRows(
    await sql`
    SELECT
      id::text AS id,
      queue_kind,
      recipient_origin,
      status,
      attempt_count,
      last_error_code,
      last_http_status,
      available_at,
      created_at,
      started_at,
      completed_at,
      updated_at
    FROM public.activitypub_queue_messages
    WHERE id = ${messageId}::uuid
    LIMIT 1
  `,
  );
  if (rows.length === 0) {
    return undefined;
  }
  return parseQueueInspectRow(rows[0]);
}

function validateMutationPreconditions(
  row: ActivityPubQueueInspectView,
  expectedUpdatedAt: Date,
): ActivityPubQueueAdminMutationResult | undefined {
  if (row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    return { status: 'stale_state' };
  }
  if (row.status !== 'retry_exhausted') {
    return { status: 'invalid_status', currentStatus: row.status };
  }
  return undefined;
}

async function mutateRetryExhaustedQueueMessage(input: {
  sql: postgres.Sql;
  messageId: string;
  expectedUpdatedAt: Date;
  changeRef: string;
  action: ActivityPubQueueOperatorAction;
  newStatus: ActivityPubQueueStatus;
  resetForRequeue: boolean;
}): Promise<ActivityPubQueueAdminMutationResult> {
  return input.sql.begin(async (transaction) => {
    const lockRows = readSqlRows(
      await transaction`
      SELECT
        id::text AS id,
        queue_kind,
        recipient_origin,
        status,
        attempt_count,
        last_error_code,
        last_http_status,
        available_at,
        created_at,
        started_at,
        completed_at,
        updated_at,
        worker_token::text AS worker_token,
        lease_expires_at,
        COALESCE(lease_expires_at > now(), false) AS has_active_lease
      FROM public.activitypub_queue_messages
      WHERE id = ${input.messageId}::uuid
      FOR UPDATE
    `,
    );
    if (lockRows.length === 0) {
      return { status: 'not_found' };
    }

    const locked = parseQueueInspectRow(lockRows[0]);
    const lockedRecord = lockRows[0];
    if (!isRecord(lockedRecord)) {
      throw new Error('Invalid ActivityPub queue mutation row.');
    }
    parseNullableDate(lockedRecord.lease_expires_at, 'lease_expires_at');
    if (parseRequiredBoolean(lockedRecord.has_active_lease, 'has_active_lease')) {
      return { status: 'active_lease' };
    }

    const preconditionFailure = validateMutationPreconditions(locked, input.expectedUpdatedAt);
    if (preconditionFailure) {
      return preconditionFailure;
    }

    const auditRows = readSqlRows(
      await transaction`
      INSERT INTO public.activitypub_queue_operator_actions (
        queue_message_id,
        action,
        previous_status,
        new_status,
        previous_attempt_count,
        previous_error_code,
        previous_http_status,
        change_ref
      )
      VALUES (
        ${input.messageId}::uuid,
        ${input.action},
        ${locked.status},
        ${input.newStatus},
        ${locked.attemptCount},
        ${locked.lastErrorCode},
        ${locked.lastHttpStatus},
        ${input.changeRef}
      )
      RETURNING id::text AS id
    `,
    );
    if (!isRecord(auditRows[0])) {
      throw new Error('ActivityPub queue operator audit row was not returned.');
    }
    const auditActionId = parseRequiredString(auditRows[0].id, 'id');

    const updatedRows = readSqlRows(
      input.resetForRequeue
        ? await transaction`
            UPDATE public.activitypub_queue_messages
            SET
              status = 'pending',
              attempt_count = 0,
              available_at = now(),
              worker_token = NULL,
              lease_expires_at = NULL,
              attempt_lease_started_at = NULL,
              started_at = NULL,
              completed_at = NULL,
              last_error_code = NULL,
              last_http_status = NULL,
              updated_at = now()
            WHERE id = ${input.messageId}::uuid
            RETURNING
              id::text AS id,
              queue_kind,
              recipient_origin,
              status,
              attempt_count,
              last_error_code,
              last_http_status,
              available_at,
              created_at,
              started_at,
              completed_at,
              updated_at
          `
        : await transaction`
            UPDATE public.activitypub_queue_messages
            SET
              status = 'permanent_failure',
              worker_token = NULL,
              lease_expires_at = NULL,
              attempt_lease_started_at = NULL,
              completed_at = now(),
              updated_at = now()
            WHERE id = ${input.messageId}::uuid
            RETURNING
              id::text AS id,
              queue_kind,
              recipient_origin,
              status,
              attempt_count,
              last_error_code,
              last_http_status,
              available_at,
              created_at,
              started_at,
              completed_at,
              updated_at
          `,
    );

    return {
      status: 'updated',
      action: input.action,
      auditActionId,
      message: parseQueueInspectRow(updatedRows[0]),
    };
  });
}

/**
 * Requeues a retry-exhausted queue message after optimistic-lock and lease checks.
 * Writes a durable operator audit row in the same transaction.
 */
export async function requeueRetryExhaustedActivityPubQueueMessage(
  sql: postgres.Sql,
  input: ActivityPubQueueAdminMutationInput,
): Promise<ActivityPubQueueAdminMutationResult> {
  return mutateRetryExhaustedQueueMessage({
    sql,
    messageId: input.messageId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    changeRef: input.changeRef,
    action: 'requeue',
    newStatus: 'pending',
    resetForRequeue: true,
  });
}

/**
 * Discards a retry-exhausted queue message as permanent failure while preserving safe error metadata.
 * Writes a durable operator audit row in the same transaction.
 */
export async function discardRetryExhaustedActivityPubQueueMessage(
  sql: postgres.Sql,
  input: ActivityPubQueueAdminMutationInput,
): Promise<ActivityPubQueueAdminMutationResult> {
  return mutateRetryExhaustedQueueMessage({
    sql,
    messageId: input.messageId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    changeRef: input.changeRef,
    action: 'discard',
    newStatus: 'permanent_failure',
    resetForRequeue: false,
  });
}

/** Serializes snapshot counters for structured dispatcher metrics logs. */
export function serializeActivityPubQueueMetricsEvent(input: {
  snapshot: ActivityPubOperationsSnapshot;
  dispatcherDurationMs: number;
}): Record<string, unknown> {
  const queueDepthTotal =
    input.snapshot.queueDepth.pending +
    input.snapshot.queueDepth.running +
    input.snapshot.queueDepth.retryWait;

  return {
    event: ACTIVITYPUB_QUEUE_METRICS_EVENT,
    bodyless: true,
    schemaVersion: input.snapshot.schemaVersion,
    windowHours: input.snapshot.windowHours,
    dispatcherDurationMs: input.dispatcherDurationMs,
    queueDepthPending: input.snapshot.queueDepth.pending,
    queueDepthRunning: input.snapshot.queueDepth.running,
    queueDepthRetryWait: input.snapshot.queueDepth.retryWait,
    queueDepthTotal,
    oldestBacklogAgeSeconds: input.snapshot.oldestBacklogAgeSeconds,
    succeededInWindow: input.snapshot.succeededInWindow,
    retryWaitCurrentCount: input.snapshot.retryWaitCurrentCount,
    retryExhaustedCurrentCount: input.snapshot.retryExhaustedCurrentCount,
    retryExhaustedInWindow: input.snapshot.retryExhaustedInWindow,
    permanentFailuresInWindow: input.snapshot.permanentFailuresInWindow,
    http429FailuresInWindow: input.snapshot.http429FailuresInWindow,
    http5xxFailuresInWindow: input.snapshot.http5xxFailuresInWindow,
    totalBusinessTableBytes: input.snapshot.totalBusinessTableBytes,
  };
}

/** Serializes one capped origin failure summary for structured dispatcher metrics logs. */
export function serializeActivityPubOriginFailureMetricsEvent(
  summary: ActivityPubOriginFailureSummary,
): Record<string, unknown> {
  const totalFailureCount =
    summary.retryCount +
    summary.retryExhaustedCount +
    summary.permanentFailureCount +
    summary.http429Count +
    summary.http5xxCount;

  return {
    event: ACTIVITYPUB_ORIGIN_FAILURE_METRICS_EVENT,
    bodyless: true,
    schemaVersion: ACTIVITYPUB_OPERATIONS_SCHEMA_VERSION,
    origin: summary.origin,
    retryCount: summary.retryCount,
    retryExhaustedCount: summary.retryExhaustedCount,
    permanentFailureCount: summary.permanentFailureCount,
    http429Count: summary.http429Count,
    http5xxCount: summary.http5xxCount,
    totalFailureCount,
  };
}
