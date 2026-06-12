export interface FetchWithRetryOptions {
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  jitterRatio?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_MAX_DELAY_MS = 30_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const jitterRatio = Math.max(0, options.jitterRatio ?? DEFAULT_JITTER_RATIO);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(input, init);
      if (!isRetryableResponse(response) || attempt === maxAttempts) {
        return response;
      }
      await cancelResponseBody(response);
      await delay(
        withJitter(
          retryDelayMs(response, attempt, baseDelayMs, maxDelayMs),
          jitterRatio,
          maxDelayMs,
        ),
      );
    } catch (error) {
      if (isAbortError(error) || attempt === maxAttempts) {
        throw error;
      }
      await delay(
        withJitter(exponentialDelayMs(attempt, baseDelayMs, maxDelayMs), jitterRatio, maxDelayMs),
      );
    }
  }

  throw new Error('fetchWithRetry exhausted attempts unexpectedly.');
}

function isRetryableResponse(response: Response): boolean {
  return RETRYABLE_STATUS.has(response.status);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore body cancellation failures; the next retry should still proceed.
  }
}

function retryDelayMs(
  response: Response,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter?.trim()) {
    const parsedSeconds = Number(retryAfter);
    if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) {
      return clampDelay(parsedSeconds * 1000, maxDelayMs);
    }
    const parsedDate = Date.parse(retryAfter);
    if (!Number.isNaN(parsedDate)) {
      return clampDelay(parsedDate - responseDateMs(response), maxDelayMs);
    }
  }
  return exponentialDelayMs(attempt, baseDelayMs, maxDelayMs);
}

function responseDateMs(response: Response): number {
  const dateHeader = response.headers.get('date');
  if (!dateHeader) {
    return Date.now();
  }
  const parsedDate = Date.parse(dateHeader);
  return Number.isNaN(parsedDate) ? Date.now() : parsedDate;
}

function exponentialDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return clampDelay(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
}

function clampDelay(ms: number, maxDelayMs: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 0;
  }
  return Math.min(Math.round(ms), maxDelayMs);
}

function withJitter(ms: number, jitterRatio: number, maxDelayMs: number): number {
  if (ms <= 0 || jitterRatio <= 0) {
    return ms;
  }
  const jitter = ms * jitterRatio;
  return clampDelay(ms - jitter + Math.random() * jitter * 2, maxDelayMs);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
