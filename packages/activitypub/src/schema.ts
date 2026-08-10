import type { DeliveryErrorCode } from './delivery-errors.ts';
import { isDeliveryErrorCode } from './delivery-errors.ts';

export type ActivityPubQueueKind = 'inbox' | 'outbox';

export type ActivityPubQueueStatus =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'retry_exhausted'
  | 'permanent_failure';

/** Parsed locked project scope row used for federation mutations. */
export type ActivityPubProjectScope = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly visibility: 'public' | 'private';
};

/** Parsed actor encrypted key material row. */
export type ActivityPubActorEncryptedKeyRow = {
  readonly encryptedPrivateKey: Readonly<Record<string, unknown>>;
  readonly publicKeyPem: string;
};

/** Parsed ActivityPub queue message row. */
export type ActivityPubQueueMessage = {
  readonly id: string;
  readonly dedupeKey: string;
  readonly queueKind: ActivityPubQueueKind;
  readonly orderingKey: string | null;
  readonly recipientOrigin: string | null;
  readonly messageJson: Readonly<Record<string, unknown>>;
  readonly status: ActivityPubQueueStatus;
  readonly availableAt: Date;
  readonly attemptCount: number;
  readonly workerToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly lastErrorCode: DeliveryErrorCode | null;
  readonly lastHttpStatus: number | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly updatedAt: Date;
};

export type ObjectRepresentation = 'article' | 'note';

export type ActivityPubActorKind = 'project' | 'aggregate';

export type ActivityPubFollowDirection = 'inbound' | 'outbound';

export type ActivityPubFollowStatus = 'pending' | 'accepted' | 'rejected' | 'undone';

export type ActivityPubActivityDirection = 'inbound' | 'outbound';

export type ActivityPubActivityProcessingStatus = 'pending' | 'running' | 'processed' | 'failed';

export type FederatedReportObjectType = 'article' | 'note';

/** Parsed singleton ActivityPub instance configuration row. */
export type ActivityPubInstanceConfig = {
  readonly id: 1;
  readonly objectRepresentation: ObjectRepresentation;
  readonly representationLockedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** Parsed ActivityPub actor row exposed to callers. */
export type ActivityPubActor = {
  readonly id: string;
  readonly projectId: string | null;
  readonly kind: ActivityPubActorKind;
  readonly preferredUsername: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly publicKeyPem: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** Parsed ActivityPub follow row. */
export type ActivityPubFollow = {
  readonly id: string;
  readonly direction: ActivityPubFollowDirection;
  readonly localActorId: string;
  readonly remoteActorUri: string;
  readonly remoteInboxUri: string;
  readonly remoteSharedInboxUri: string | null;
  readonly followActivityUri: string;
  readonly status: ActivityPubFollowStatus;
  readonly createdAt: Date;
  readonly acceptedAt: Date | null;
  readonly undoneAt: Date | null;
  readonly updatedAt: Date;
};

/** Parsed ActivityPub activity row. */
export type ActivityPubActivity = {
  readonly id: string;
  readonly activityUri: string;
  readonly objectUri: string | null;
  readonly activityType: string;
  readonly actorUri: string;
  readonly localActorId: string | null;
  readonly direction: ActivityPubActivityDirection;
  readonly payloadJson: Readonly<Record<string, unknown>>;
  readonly processingStatus: ActivityPubActivityProcessingStatus;
  readonly availableAt: Date;
  readonly attemptCount: number;
  readonly workerToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly occurredAt: Date;
  readonly processedAt: Date | null;
};

/** Parsed federated report row. */
export type FederatedReport = {
  readonly id: string;
  readonly projectId: string;
  readonly sourceFollowId: string;
  readonly remoteObjectUri: string;
  readonly remoteActivityUri: string;
  readonly remoteActorUri: string;
  readonly objectType: FederatedReportObjectType;
  readonly title: string;
  readonly summaryHtmlSanitized: string;
  readonly originalUrl: string;
  readonly publishedAt: Date | null;
  readonly remoteUpdatedAt: Date | null;
  readonly receivedAt: Date;
};

/** Public report article metadata resolved for ActivityPub object dispatch. */
export type PublicReportArticle = {
  readonly reportId: string;
  readonly projectSlug: string;
  readonly projectId: string;
  readonly preferredUsername: string;
  readonly title: string;
  readonly summary: string;
  readonly publishedAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ActivityPub row field: ${fieldName}`);
  }
  return value;
}

function parseNullableString(value: unknown, fieldName: string): string | null {
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid ActivityPub row field: ${fieldName}`);
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
  throw new Error(`Invalid ActivityPub row field: ${fieldName}`);
}

function parseNullableDate(value: unknown, fieldName: string): Date | null {
  if (value === null) {
    return null;
  }
  return parseRequiredDate(value, fieldName);
}

function parseRequiredBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Invalid ActivityPub row field: ${fieldName}`);
}

function parseObjectRepresentation(value: unknown): ObjectRepresentation {
  const representation = parseRequiredString(value, 'object_representation');
  if (representation === 'article' || representation === 'note') {
    return representation;
  }
  throw new Error('Invalid ActivityPub row field: object_representation');
}

function parseActorKind(value: unknown): ActivityPubActorKind {
  const kind = parseRequiredString(value, 'kind');
  if (kind === 'project' || kind === 'aggregate') {
    return kind;
  }
  throw new Error('Invalid ActivityPub row field: kind');
}

function parseFollowDirection(value: unknown): ActivityPubFollowDirection {
  const direction = parseRequiredString(value, 'direction');
  if (direction === 'inbound' || direction === 'outbound') {
    return direction;
  }
  throw new Error('Invalid ActivityPub row field: direction');
}

function parseFollowStatus(value: unknown): ActivityPubFollowStatus {
  const status = parseRequiredString(value, 'status');
  if (
    status === 'pending' ||
    status === 'accepted' ||
    status === 'rejected' ||
    status === 'undone'
  ) {
    return status;
  }
  throw new Error('Invalid ActivityPub row field: status');
}

function parseActivityDirection(value: unknown): ActivityPubActivityDirection {
  const direction = parseRequiredString(value, 'direction');
  if (direction === 'inbound' || direction === 'outbound') {
    return direction;
  }
  throw new Error('Invalid ActivityPub row field: direction');
}

function parseActivityProcessingStatus(value: unknown): ActivityPubActivityProcessingStatus {
  const status = parseRequiredString(value, 'processing_status');
  if (
    status === 'pending' ||
    status === 'running' ||
    status === 'processed' ||
    status === 'failed'
  ) {
    return status;
  }
  throw new Error('Invalid ActivityPub row field: processing_status');
}

function parseFederatedReportObjectType(value: unknown): FederatedReportObjectType {
  const objectType = parseRequiredString(value, 'object_type');
  if (objectType === 'article' || objectType === 'note') {
    return objectType;
  }
  throw new Error('Invalid ActivityPub row field: object_type');
}

function parseJsonObject(value: unknown, fieldName: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ActivityPub row field: ${fieldName}`);
  }
  return value;
}

function parseProjectVisibility(value: unknown): 'public' | 'private' {
  const visibility = parseRequiredString(value, 'visibility');
  if (visibility === 'public' || visibility === 'private') {
    return visibility;
  }
  throw new Error('Invalid ActivityPub row field: visibility');
}

function parseQueueKind(value: unknown): ActivityPubQueueKind {
  const queueKind = parseRequiredString(value, 'queue_kind');
  if (queueKind === 'inbox' || queueKind === 'outbox') {
    return queueKind;
  }
  throw new Error('Invalid ActivityPub row field: queue_kind');
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
  throw new Error('Invalid ActivityPub row field: status');
}

function parseNullableInteger(value: unknown, fieldName: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  throw new Error(`Invalid ActivityPub row field: ${fieldName}`);
}

function parseRequiredInteger(value: unknown, fieldName: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  throw new Error(`Invalid ActivityPub row field: ${fieldName}`);
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
  throw new Error(`Invalid ActivityPub row field: ${fieldName}`);
}

/** Parses a locked project scope row from a SQL query result. */
export function parseActivityPubProjectScopeRow(row: unknown): ActivityPubProjectScope {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub project scope row.');
  }
  return {
    id: parseRequiredString(row.id, 'id'),
    slug: parseRequiredString(row.slug, 'slug'),
    name: parseRequiredString(row.name, 'name'),
    visibility: parseProjectVisibility(row.visibility),
  };
}

/** Parses actor encrypted key material from a SQL query result. */
export function parseActivityPubActorEncryptedKeyRow(
  row: unknown,
): ActivityPubActorEncryptedKeyRow {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub actor encrypted key row.');
  }
  return {
    encryptedPrivateKey: parseJsonObject(row.encrypted_private_key, 'encrypted_private_key'),
    publicKeyPem: parseRequiredString(row.public_key_pem, 'public_key_pem'),
  };
}

/** Parses an ActivityPub queue message row from a SQL query result. */
export function parseActivityPubQueueMessageRow(row: unknown): ActivityPubQueueMessage {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub queue message row.');
  }
  return {
    id: parseRequiredString(row.id, 'id'),
    dedupeKey: parseRequiredString(row.dedupe_key, 'dedupe_key'),
    queueKind: parseQueueKind(row.queue_kind),
    orderingKey: parseNullableString(row.ordering_key, 'ordering_key'),
    recipientOrigin: parseNullableString(row.recipient_origin, 'recipient_origin'),
    messageJson: parseJsonObject(row.message_json, 'message_json'),
    status: parseQueueStatus(row.status),
    availableAt: parseRequiredDate(row.available_at, 'available_at'),
    attemptCount: parseRequiredInteger(row.attempt_count, 'attempt_count'),
    workerToken: parseNullableString(row.worker_token, 'worker_token'),
    leaseExpiresAt: parseNullableDate(row.lease_expires_at, 'lease_expires_at'),
    lastErrorCode: parseNullableDeliveryErrorCode(row.last_error_code, 'last_error_code'),
    lastHttpStatus: parseNullableInteger(row.last_http_status, 'last_http_status'),
    createdAt: parseRequiredDate(row.created_at, 'created_at'),
    startedAt: parseNullableDate(row.started_at, 'started_at'),
    completedAt: parseNullableDate(row.completed_at, 'completed_at'),
    updatedAt: parseRequiredDate(row.updated_at, 'updated_at'),
  };
}

/** Parses a singleton instance configuration row from a SQL query result. */
export function parseActivityPubInstanceConfigRow(row: unknown): ActivityPubInstanceConfig {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub instance config row.');
  }
  const id = row.id;
  if (id !== 1) {
    throw new Error('Invalid ActivityPub instance config row field: id');
  }
  return {
    id: 1,
    objectRepresentation: parseObjectRepresentation(row.object_representation),
    representationLockedAt: parseNullableDate(
      row.representation_locked_at,
      'representation_locked_at',
    ),
    createdAt: parseRequiredDate(row.created_at, 'created_at'),
    updatedAt: parseRequiredDate(row.updated_at, 'updated_at'),
  };
}

/** Parses an ActivityPub actor row from a SQL query result. */
export function parseActivityPubActorRow(row: unknown): ActivityPubActor {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub actor row.');
  }
  return {
    id: parseRequiredString(row.id, 'id'),
    projectId: parseNullableString(row.project_id, 'project_id'),
    kind: parseActorKind(row.kind),
    preferredUsername: parseRequiredString(row.preferred_username, 'preferred_username'),
    displayName: parseRequiredString(row.display_name, 'display_name'),
    enabled: parseRequiredBoolean(row.enabled, 'enabled'),
    publicKeyPem: parseRequiredString(row.public_key_pem, 'public_key_pem'),
    createdAt: parseRequiredDate(row.created_at, 'created_at'),
    updatedAt: parseRequiredDate(row.updated_at, 'updated_at'),
  };
}

/** Parses an ActivityPub follow row from a SQL query result. */
export function parseActivityPubFollowRow(row: unknown): ActivityPubFollow {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub follow row.');
  }
  return {
    id: parseRequiredString(row.id, 'id'),
    direction: parseFollowDirection(row.direction),
    localActorId: parseRequiredString(row.local_actor_id, 'local_actor_id'),
    remoteActorUri: parseRequiredString(row.remote_actor_uri, 'remote_actor_uri'),
    remoteInboxUri: parseRequiredString(row.remote_inbox_uri, 'remote_inbox_uri'),
    remoteSharedInboxUri: parseNullableString(
      row.remote_shared_inbox_uri,
      'remote_shared_inbox_uri',
    ),
    followActivityUri: parseRequiredString(row.follow_activity_uri, 'follow_activity_uri'),
    status: parseFollowStatus(row.status),
    createdAt: parseRequiredDate(row.created_at, 'created_at'),
    acceptedAt: parseNullableDate(row.accepted_at, 'accepted_at'),
    undoneAt: parseNullableDate(row.undone_at, 'undone_at'),
    updatedAt: parseRequiredDate(row.updated_at, 'updated_at'),
  };
}

/** Parses an ActivityPub activity row from a SQL query result. */
export function parseActivityPubActivityRow(row: unknown): ActivityPubActivity {
  if (!isRecord(row)) {
    throw new Error('Invalid ActivityPub activity row.');
  }
  return {
    id: parseRequiredString(row.id, 'id'),
    activityUri: parseRequiredString(row.activity_uri, 'activity_uri'),
    objectUri: parseNullableString(row.object_uri, 'object_uri'),
    activityType: parseRequiredString(row.activity_type, 'activity_type'),
    actorUri: parseRequiredString(row.actor_uri, 'actor_uri'),
    localActorId: parseNullableString(row.local_actor_id, 'local_actor_id'),
    direction: parseActivityDirection(row.direction),
    payloadJson: parseJsonObject(row.payload_json, 'payload_json'),
    processingStatus: parseActivityProcessingStatus(row.processing_status),
    availableAt: parseRequiredDate(row.available_at, 'available_at'),
    attemptCount: parseRequiredInteger(row.attempt_count, 'attempt_count'),
    workerToken: parseNullableString(row.worker_token, 'worker_token'),
    leaseExpiresAt: parseNullableDate(row.lease_expires_at, 'lease_expires_at'),
    occurredAt: parseRequiredDate(row.occurred_at, 'occurred_at'),
    processedAt: parseNullableDate(row.processed_at, 'processed_at'),
  };
}

/** Parses a federated report row from a SQL query result. */
export function parseFederatedReportRow(row: unknown): FederatedReport {
  if (!isRecord(row)) {
    throw new Error('Invalid federated report row.');
  }
  return {
    id: parseRequiredString(row.id, 'id'),
    projectId: parseRequiredString(row.project_id, 'project_id'),
    sourceFollowId: parseRequiredString(row.source_follow_id, 'source_follow_id'),
    remoteObjectUri: parseRequiredString(row.remote_object_uri, 'remote_object_uri'),
    remoteActivityUri: parseRequiredString(row.remote_activity_uri, 'remote_activity_uri'),
    remoteActorUri: parseRequiredString(row.remote_actor_uri, 'remote_actor_uri'),
    objectType: parseFederatedReportObjectType(row.object_type),
    title: parseRequiredString(row.title, 'title'),
    summaryHtmlSanitized: parseRequiredString(row.summary_html_sanitized, 'summary_html_sanitized'),
    originalUrl: parseRequiredString(row.original_url, 'original_url'),
    publishedAt: parseNullableDate(row.published_at, 'published_at'),
    remoteUpdatedAt: parseNullableDate(row.remote_updated_at, 'remote_updated_at'),
    receivedAt: parseRequiredDate(row.received_at, 'received_at'),
  };
}

/** Parses public report article metadata from a SQL query result. */
export function parsePublicReportArticleRow(row: unknown): PublicReportArticle {
  if (!isRecord(row)) {
    throw new Error('Invalid public report article row.');
  }
  return {
    reportId: parseRequiredString(row.report_id, 'report_id'),
    projectSlug: parseRequiredString(row.project_slug, 'project_slug'),
    projectId: parseRequiredString(row.project_id, 'project_id'),
    preferredUsername: parseRequiredString(row.preferred_username, 'preferred_username'),
    title: parseRequiredString(row.title, 'title'),
    summary: parseRequiredString(row.summary ?? '', 'summary'),
    publishedAt: parseRequiredDate(row.published_at, 'published_at'),
  };
}

/** Parses the first row from a SQL result set or returns undefined when empty. */
export function parseOptionalRow<T>(
  rows: readonly unknown[],
  parser: (row: unknown) => T,
): T | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  return parser(rows[0]);
}

/** Parses the first row from a SQL result set or throws when empty. */
export function parseRequiredRow<T>(rows: readonly unknown[], parser: (row: unknown) => T): T {
  const parsed = parseOptionalRow(rows, parser);
  if (!parsed) {
    throw new Error('Expected ActivityPub SQL row was not found.');
  }
  return parsed;
}
