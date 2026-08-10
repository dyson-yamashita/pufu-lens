import { parseRetryAfterHeader } from './dispatcher.ts';

/** Fixed allowlist of delivery error codes persisted to PostgreSQL. */
export const DELIVERY_ERROR_CODES = {
  deliveryTimeout: 'delivery_timeout',
  networkError: 'network_error',
  http408: 'http_408',
  http429: 'http_429',
  http5xx: 'http_5xx',
  inboxGone: 'inbox_gone',
  http4xx: 'http_4xx',
  unknownDeliveryError: 'unknown_delivery_error',
  leaseLost: 'lease_lost',
  predecessorFailure: 'activitypub_predecessor_failure',
  materializationPrivate: 'activitypub_materialization_private',
  materializationDisabled: 'activitypub_materialization_disabled',
  materializationRepresentation: 'activitypub_materialization_representation',
  materializationRetryExhausted: 'activitypub_materialization_retry_exhausted',
} as const;

/** Runtime type guard for the fixed delivery error code allowlist. */
export function isDeliveryErrorCode(value: unknown): value is DeliveryErrorCode {
  return typeof value === 'string' && DELIVERY_ERROR_CODE_SET.has(value);
}

const DELIVERY_ERROR_CODE_SET = new Set<string>(Object.values(DELIVERY_ERROR_CODES));

export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[keyof typeof DELIVERY_ERROR_CODES];

/** Thrown when a queue finalizer loses its lease before updating status. */
export class LeaseLostError extends Error {
  constructor() {
    super(DELIVERY_ERROR_CODES.leaseLost);
    this.name = 'LeaseLostError';
  }
}

export type MappedDeliveryError = {
  readonly code: DeliveryErrorCode;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
};

/**
 * Maps processor errors to a fixed delivery error code without leaking secrets,
 * response bodies, URLs with credentials, or raw exception messages.
 */
export function mapDeliveryError(error: unknown): MappedDeliveryError {
  if (error instanceof LeaseLostError) {
    return { code: DELIVERY_ERROR_CODES.leaseLost };
  }
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    const httpStatus = readHttpStatus(record);
    const retryAfterMs = readRetryAfterMs(record);
    if (isDeliveryErrorCode(record.code)) {
      return {
        code: record.code,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    if (httpStatus === 404 || httpStatus === 410) {
      return { code: DELIVERY_ERROR_CODES.inboxGone, httpStatus };
    }
    if (httpStatus === 408) {
      return {
        code: DELIVERY_ERROR_CODES.http408,
        httpStatus,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    if (httpStatus === 429) {
      return {
        code: DELIVERY_ERROR_CODES.http429,
        httpStatus,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    if (typeof httpStatus === 'number' && httpStatus >= 500) {
      return {
        code: DELIVERY_ERROR_CODES.http5xx,
        httpStatus,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
      return { code: DELIVERY_ERROR_CODES.http4xx, httpStatus };
    }
  }
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    if (name.includes('abort') || name.includes('timeout')) {
      return { code: DELIVERY_ERROR_CODES.deliveryTimeout };
    }
    if (name.includes('fetch') || name.includes('network')) {
      return { code: DELIVERY_ERROR_CODES.networkError };
    }
  }
  return { code: DELIVERY_ERROR_CODES.unknownDeliveryError };
}

function readHttpStatus(record: Record<string, unknown>): number | undefined {
  for (const field of ['statusCode', 'httpStatus', 'status'] as const) {
    const value = record[field];
    if (isValidHttpStatus(value)) {
      return value;
    }
  }
  return undefined;
}

function readRetryAfterMs(record: Record<string, unknown>): number | undefined {
  const directValue = record.retryAfterMs;
  if (isValidRetryAfterMs(directValue)) {
    return directValue;
  }
  return readRetryAfterFromHeaders(record.responseHeaders);
}

function isValidHttpStatus(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

function isValidRetryAfterMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readRetryAfterFromHeaders(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const headers = value as Record<string, unknown>;
  const retryAfter =
    headers['retry-after'] ?? headers['Retry-After'] ?? headers.retryAfter ?? headers.RetryAfter;
  if (typeof retryAfter !== 'string') {
    return undefined;
  }
  return parseRetryAfterHeader(retryAfter);
}
