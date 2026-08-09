import { type MappedDeliveryError, mapDeliveryError } from './delivery-errors.ts';
import { parseRetryAfterHeader } from './dispatcher.ts';

/** Records Fedify outbox delivery failures for dispatcher-owned PostgreSQL finalization. */
export type DeliveryErrorObserver = {
  readonly record: (error: unknown) => void;
  readonly consume: () => MappedDeliveryError | null;
};

/** Creates a scoped delivery error observer used during one `processQueuedTask` call. */
export function createDeliveryErrorObserver(): DeliveryErrorObserver {
  let recorded: MappedDeliveryError | null = null;
  return {
    record(error: unknown) {
      recorded = mapFedifyDeliveryError(error);
    },
    consume() {
      const value = recorded;
      recorded = null;
      return value;
    },
  };
}

/** Converts a mapped delivery error into a throwable value for queue finalizers. */
export function toObservedDeliveryError(mapped: MappedDeliveryError): Error & MappedDeliveryError {
  return Object.assign(new Error(mapped.code), mapped);
}

/**
 * Maps Fedify `SendActivityError` and compatible transport errors without logging secrets,
 * response bodies, URL credentials, or private key material.
 */
export function mapFedifyDeliveryError(error: unknown): MappedDeliveryError {
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    const statusCode = readHttpStatus(record);
    const retryAfterMs = readRetryAfterMs(record);
    if (statusCode !== undefined || retryAfterMs !== undefined) {
      return mapDeliveryError({
        httpStatus: statusCode,
        retryAfterMs,
      });
    }
  }
  return mapDeliveryError(error);
}

function readHttpStatus(record: Record<string, unknown>): number | undefined {
  if (typeof record.statusCode === 'number') {
    return record.statusCode;
  }
  if (typeof record.httpStatus === 'number') {
    return record.httpStatus;
  }
  if (typeof record.status === 'number') {
    return record.status;
  }
  return undefined;
}

function readRetryAfterMs(record: Record<string, unknown>): number | undefined {
  if (typeof record.retryAfterMs === 'number') {
    return record.retryAfterMs;
  }
  const retryAfter = readRetryAfterHeaderValue(record.responseHeaders);
  if (retryAfter !== undefined) {
    return parseRetryAfterHeader(retryAfter);
  }
  if (typeof record.retryAfter === 'string') {
    return parseRetryAfterHeader(record.retryAfter);
  }
  return undefined;
}

function readRetryAfterHeaderValue(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  if (headers instanceof Headers) {
    try {
      return headers.get('retry-after') ?? headers.get('Retry-After') ?? undefined;
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(headers)) {
    return undefined;
  }
  const headerRecord = headers as Record<string, unknown>;
  if (typeof headerRecord.get === 'function') {
    try {
      const get = headerRecord.get as (name: string) => unknown;
      const value = get.call(headerRecord, 'retry-after') ?? get.call(headerRecord, 'Retry-After');
      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  }
  const retryAfter =
    headerRecord['retry-after'] ??
    headerRecord['Retry-After'] ??
    headerRecord.retryAfter ??
    headerRecord.RetryAfter;
  return typeof retryAfter === 'string' ? retryAfter : undefined;
}
