export interface FetchWithRetryOptions {
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(input, init);
      if (!isRetryableResponse(response) || attempt === maxAttempts) {
        return response;
      }
      await delay(retryDelayMs(response, attempt, baseDelayMs));
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }
      await delay(exponentialDelayMs(attempt, baseDelayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableResponse(response: Response): boolean {
  return RETRYABLE_STATUS.has(response.status);
}

function retryDelayMs(response: Response, attempt: number, baseDelayMs: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const parsedSeconds = Number(retryAfter);
    if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) {
      return parsedSeconds * 1000;
    }
    const parsedDate = Date.parse(retryAfter);
    if (!Number.isNaN(parsedDate)) {
      return Math.max(0, parsedDate - Date.now());
    }
  }
  return exponentialDelayMs(attempt, baseDelayMs);
}

function exponentialDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** Math.max(0, attempt - 1);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
