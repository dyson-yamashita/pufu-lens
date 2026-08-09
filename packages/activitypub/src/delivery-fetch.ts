import { DELIVERY_ERROR_CODES } from './delivery-errors.ts';

/** Default bounded timeout for one outbound ActivityPub delivery POST. */
export const DISPATCHER_DELIVERY_FETCH_TIMEOUT_MS = 120_000;

/** Thrown when a delivery fetch is aborted by the dispatcher timeout guard. */
export class DeliveryTimeoutError extends Error {
  constructor() {
    super(DELIVERY_ERROR_CODES.deliveryTimeout);
    this.name = 'DeliveryTimeoutError';
  }
}

/**
 * Temporarily replaces `globalThis.fetch` with a timeout-aware wrapper for one dispatcher job.
 * The dispatcher runs sequentially in a single process, so this scoped replacement is safe.
 */
export async function withTimedDeliveryFetch<T>(
  input: {
    readonly timeoutMs?: number;
    /** @internal Injected by unit tests to avoid real timers when asserting timeout abort mapping. */
    readonly createTimeoutSignalForTest?: (timeoutMs: number) => AbortSignal;
  },
  run: () => Promise<T>,
): Promise<T> {
  const timeoutMs = input.timeoutMs ?? DISPATCHER_DELIVERY_FETCH_TIMEOUT_MS;
  const createTimeoutSignal = input.createTimeoutSignalForTest ?? AbortSignal.timeout;
  const originalFetch = globalThis.fetch;
  let restored = false;
  const restore = () => {
    if (!restored) {
      globalThis.fetch = originalFetch;
      restored = true;
    }
  };

  globalThis.fetch = ((url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const timeoutSignal = createTimeoutSignal(timeoutMs);
    const signal = init?.signal ? mergeAbortSignals([init.signal, timeoutSignal]) : timeoutSignal;
    return originalFetch(url, { ...init, signal }).catch((error: unknown) => {
      if (isDeliveryTimeoutAbort(error, timeoutSignal)) {
        throw new DeliveryTimeoutError();
      }
      throw error;
    });
  }) as typeof fetch;

  try {
    return await run();
  } finally {
    restore();
  }
}

function mergeAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  if (signals.length === 1) {
    return signals[0] as AbortSignal;
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([...signals]);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function isDeliveryTimeoutAbort(error: unknown, timeoutSignal: AbortSignal): boolean {
  if (!timeoutSignal.aborted) {
    return false;
  }
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    return name.includes('abort') || name.includes('timeout');
  }
  return false;
}
