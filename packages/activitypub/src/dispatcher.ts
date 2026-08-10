export type ActivityPubDispatcherClock = {
  readonly now: () => Date;
};

/** Error code used when a queue row is terminalized due to a failed ordering predecessor. */
export const PREDECESSOR_FAILURE_CODE = 'activitypub_predecessor_failure';

/** Maximum delivery attempts before retry_exhausted (initial attempt plus five retries). */
export const DISPATCHER_MAX_ATTEMPTS = 6;

/** Default bounded batch size for one dispatcher run. */
export const DISPATCHER_DEFAULT_BATCH_SIZE = 100;

/** Maximum runtime for claiming new work in one dispatcher run. */
export const DISPATCHER_MAX_RUNTIME_MS = 45 * 60 * 1000;

/** Lease duration for claimed rows. */
export const DISPATCHER_LEASE_MS = 15 * 60 * 1000;

/** Maximum total lease extension from attempt start. */
export const DISPATCHER_MAX_LEASE_FROM_ATTEMPT_MS = 60 * 60 * 1000;

/** Maximum bounded Retry-After delay. */
export const DISPATCHER_MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Minimum bounded Retry-After delay honored for transient retries. */
export const DISPATCHER_MIN_RETRY_AFTER_MS = 1000;

export const DISPATCHER_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

export type DeliveryFailureClassification =
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'permanent_failure' }
  | { readonly kind: 'retry_exhausted' };

export type DeliveryProcessorError = {
  readonly code: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
};

/** Classifies processor errors into retry, permanent failure, or retry exhausted. */
export function classifyDeliveryFailure(input: {
  readonly attemptCount: number;
  readonly error: DeliveryProcessorError;
}): DeliveryFailureClassification {
  if (input.attemptCount >= DISPATCHER_MAX_ATTEMPTS) {
    return { kind: 'retry_exhausted' };
  }
  const status = input.error.httpStatus;
  if (status === 404 || status === 410) {
    return { kind: 'permanent_failure' };
  }
  if (status === 408 || status === 429 || (typeof status === 'number' && status >= 500)) {
    return {
      kind: 'retry',
      delayMs: resolveRetryDelayMs({
        attemptCount: input.attemptCount,
        retryAfterMs: input.error.retryAfterMs,
      }),
    };
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { kind: 'permanent_failure' };
  }
  return {
    kind: 'retry',
    delayMs: resolveRetryDelayMs({
      attemptCount: input.attemptCount,
      retryAfterMs: input.error.retryAfterMs,
    }),
  };
}

/** Resolves the retry delay for an attempt, honoring bounded Retry-After when valid. */
export function resolveRetryDelayMs(input: {
  readonly attemptCount: number;
  readonly retryAfterMs?: number;
}): number {
  const index = Math.min(
    Math.max(input.attemptCount - 1, 0),
    DISPATCHER_RETRY_DELAYS_MS.length - 1,
  );
  const scheduleDelay =
    DISPATCHER_RETRY_DELAYS_MS[index] ?? DISPATCHER_RETRY_DELAYS_MS.at(-1) ?? 60_000;
  if (input.retryAfterMs === undefined) {
    return scheduleDelay;
  }
  if (!Number.isFinite(input.retryAfterMs) || input.retryAfterMs < 0) {
    return scheduleDelay;
  }
  return Math.max(
    DISPATCHER_MIN_RETRY_AFTER_MS,
    Math.min(input.retryAfterMs, DISPATCHER_MAX_RETRY_AFTER_MS),
  );
}

/** Computes the next lease expiry capped at 60 minutes from attempt lease start. */
export function computeHeartbeatLeaseExpiry(input: {
  readonly now: Date;
  readonly attemptLeaseStartedAt: Date;
}): Date | null {
  const maxLeaseUntil =
    input.attemptLeaseStartedAt.getTime() + DISPATCHER_MAX_LEASE_FROM_ATTEMPT_MS;
  if (input.now.getTime() >= maxLeaseUntil) {
    return null;
  }
  const proposed = input.now.getTime() + DISPATCHER_LEASE_MS;
  return new Date(Math.min(proposed, maxLeaseUntil));
}

/** Returns whether a queue row is blocked by an older non-succeeded predecessor. */
export function isBlockedByOrderingPredecessor(input: {
  readonly hasOlderIncompletePredecessor: boolean;
  readonly predecessorTerminalFailure: boolean;
}): 'claim' | 'block' | 'terminalize' {
  if (!input.hasOlderIncompletePredecessor) {
    return 'claim';
  }
  if (input.predecessorTerminalFailure) {
    return 'terminalize';
  }
  return 'block';
}

/** Alternates inbox and outbox claim preference fairly across a run. */
export function selectNextQueueKind(input: {
  readonly processedInbox: number;
  readonly processedOutbox: number;
}): 'inbox' | 'outbox' {
  if (input.processedInbox <= input.processedOutbox) {
    return 'inbox';
  }
  return 'outbox';
}

/** Parses a bounded Retry-After header value in seconds or HTTP-date form. */
export function parseRetryAfterHeader(
  value: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return undefined;
    }
    return Math.min(seconds * 1000, DISPATCHER_MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }
  const delta = date - now.getTime();
  if (delta < 0) {
    return 0;
  }
  return Math.min(delta, DISPATCHER_MAX_RETRY_AFTER_MS);
}
