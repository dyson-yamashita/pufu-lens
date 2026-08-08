import { createHash, randomUUID } from 'node:crypto';
import type {
  ActivityPubFollow,
  ActivityPubFollowDirection,
  ActivityPubFollowStatus,
} from './schema.ts';

/** Metadata-only activity receipt payload persisted in activitypub_activities. */
export type FollowActivityReceiptPayload = {
  readonly direction: ActivityPubFollowDirection;
  readonly activityType: string;
  readonly localActorId: string | null;
  readonly remoteActorUri: string | null;
};

/** Result of a follow state transition including optional outbox enqueue hints. */
export type FollowTransitionResult = {
  readonly follow: ActivityPubFollow;
  readonly outboxEnqueue?: {
    readonly activityUri: string;
    readonly activityType: string;
    readonly recipientInbox: string;
    readonly sharedInbox: boolean;
    readonly orderingKey: string;
    readonly actorKeyId: string;
    readonly localActorPreferredUsername: string;
    readonly activityJsonLd: unknown;
  };
};

/** Opaque versioned cursor for follower/following collection pagination. */
export type FollowCollectionCursor = {
  readonly version: 1;
  readonly createdAt: string;
  readonly id: string;
};

const CURSOR_VERSION = 1;
const COLLECTION_PAGE_SIZE = 20;
const MAX_REMOTE_INPUT_LENGTH = 512;

/** Returns the bounded page size for follower/following collections. */
export function getFollowCollectionPageSize(): number {
  return COLLECTION_PAGE_SIZE;
}

/** Fedify collection first-page cursor sentinel for paginated followers/following dispatchers. */
export const FOLLOW_COLLECTION_START_CURSOR = 'start';

/** Normalizes Fedify collection cursors to repository opaque cursors. */
export function resolveFollowCollectionCursor(
  cursor: string | null | undefined,
): string | undefined {
  if (!cursor || cursor === FOLLOW_COLLECTION_START_CURSOR) {
    return undefined;
  }
  return cursor;
}

/** Normalizes a remote actor URI for follow identity (lowercase origin, no fragment). */
export function normalizeRemoteActorUri(actorUri: string): string {
  const parsed = new URL(actorUri);
  if (parsed.protocol !== 'https:') {
    throw new Error('Remote actor URI must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Remote actor URI must not include credentials');
  }
  parsed.hash = '';
  return parsed.toString();
}

/** Validates an absolute HTTPS URL for ActivityPub endpoints. */
export function assertHttpsActivityPubUrl(url: string, label: string): string {
  if (url.length > MAX_REMOTE_INPUT_LENGTH) {
    throw new Error(`${label} exceeds maximum length`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not include credentials`);
  }
  if (parsed.hash) {
    throw new Error(`${label} must not include a fragment`);
  }
  return parsed.toString();
}

/** Builds a fresh outbound Follow activity URI under the canonical origin. */
export function buildOutboundFollowActivityUri(canonicalOrigin: string): string {
  const origin = canonicalOrigin.replace(/\/$/, '');
  return `${origin}/activitypub/activities/follow/${randomUUID()}`;
}

/** Builds a deterministic Accept activity URI from a Follow activity URI. */
export function buildDeterministicAcceptActivityUri(
  canonicalOrigin: string,
  followActivityUri: string,
): string {
  const origin = canonicalOrigin.replace(/\/$/, '');
  const digest = createHash('sha256').update(followActivityUri, 'utf8').digest('hex');
  return `${origin}/activitypub/activities/accept/${digest}`;
}

/** Builds a deterministic Undo activity URI from a Follow activity URI. */
export function buildDeterministicUndoActivityUri(
  canonicalOrigin: string,
  followActivityUri: string,
): string {
  const origin = canonicalOrigin.replace(/\/$/, '');
  const digest = createHash('sha256').update(`undo:${followActivityUri}`, 'utf8').digest('hex');
  return `${origin}/activitypub/activities/undo/${digest}`;
}

/** Encodes a follow collection cursor to an opaque string. */
export function encodeFollowCollectionCursor(input: { createdAt: Date; id: string }): string {
  const payload: FollowCollectionCursor = {
    version: CURSOR_VERSION,
    createdAt: input.createdAt.toISOString(),
    id: input.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decodes an opaque follow collection cursor; fails closed on invalid input. */
export function decodeFollowCollectionCursor(cursor: string): FollowCollectionCursor {
  if (!cursor || cursor.length > 512) {
    throw new Error('Invalid collection cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid collection cursor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid collection cursor');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== CURSOR_VERSION) {
    throw new Error('Invalid collection cursor version');
  }
  if (typeof record.createdAt !== 'string' || typeof record.id !== 'string') {
    throw new Error('Invalid collection cursor fields');
  }
  const createdAt = new Date(record.createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error('Invalid collection cursor timestamp');
  }
  return {
    version: CURSOR_VERSION,
    createdAt: record.createdAt,
    id: record.id,
  };
}

/** Builds metadata-only receipt payload for activitypub_activities. */
export function buildFollowActivityReceiptPayload(input: {
  direction: ActivityPubFollowDirection;
  activityType: string;
  localActorId: string | null;
  remoteActorUri: string | null;
}): FollowActivityReceiptPayload {
  return {
    direction: input.direction,
    activityType: input.activityType,
    localActorId: input.localActorId,
    remoteActorUri: input.remoteActorUri,
  };
}

/** Returns whether a follow row represents an accepted relationship for collections. */
export function isAcceptedFollowForCollection(follow: ActivityPubFollow): boolean {
  return follow.status === 'accepted';
}

/** Compares follow rows for deterministic collection ordering (created_at then id). */
export function compareFollowCollectionOrder(
  left: ActivityPubFollow,
  right: ActivityPubFollow,
): number {
  const createdDiff = left.createdAt.getTime() - right.createdAt.getTime();
  if (createdDiff !== 0) {
    return createdDiff;
  }
  return left.id.localeCompare(right.id);
}

/** Returns whether a follow status allows outbound undo. */
export function canUndoOutboundFollow(status: ActivityPubFollowStatus): boolean {
  return status === 'pending' || status === 'accepted';
}

/** Returns whether accepting an outbound follow receipt is meaningful. */
export function canAcceptOutboundFollowReceipt(status: ActivityPubFollowStatus): boolean {
  return status === 'pending';
}
