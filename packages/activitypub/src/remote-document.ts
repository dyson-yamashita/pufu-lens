import { validatePublicUrl } from '@fedify/vocab-runtime';
import { parseCanonicalOrigin } from './canonical-origin.ts';

/** Predicate that blocks federation to specific hostnames. */
export type BlockedDomainPredicate = (hostname: string) => boolean;

export const REMOTE_FETCH_MAX_REDIRECTS = 5;
export const REMOTE_FETCH_TOTAL_TIMEOUT_MS = 5000;
export const REMOTE_FETCH_MAX_RESPONSE_BYTES = 1024 * 1024;

type FetchLike = typeof fetch;

/** Input for bounded remote JSON document fetch. */
export type CreateBoundedRemoteJsonFetcherInput = {
  canonicalOrigin: string;
  fetch: FetchLike;
  isDomainBlocked: BlockedDomainPredicate;
  /** Hermetic tests inject a no-op URL validator to avoid DNS lookups. */
  validateUrl?: (url: string) => Promise<void>;
};

/** Bounded remote JSON fetcher with redirect and size limits. */
export type BoundedRemoteJsonFetcher = {
  fetchJsonDocument(url: string): Promise<{ document: Record<string, unknown>; finalUrl: string }>;
};

function isHostnameBlocked(hostname: string, blockedDomains: readonly string[]): boolean {
  const normalized = hostname.toLowerCase();
  for (const blocked of blockedDomains) {
    if (normalized === blocked || normalized.endsWith(`.${blocked}`)) {
      return true;
    }
  }
  return false;
}

function assertHostnameAllowed(hostname: string, isDomainBlocked: BlockedDomainPredicate): void {
  if (isDomainBlocked(hostname.toLowerCase())) {
    throw new Error('Remote domain is blocked');
  }
}

function assertNotCanonicalRemoteOrigin(url: string, canonicalOrigin: string): void {
  const canonical = parseCanonicalOrigin(canonicalOrigin).origin;
  const target = new URL(url);
  if (target.origin === canonical) {
    throw new Error('Cannot fetch local canonical origin');
  }
}

async function validateUrlWithDeadline(
  validateUrl: (url: string) => Promise<void>,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new Error('Remote fetch timed out');
  }
  let onAbort: () => void = () => {
    throw new Error('Remote fetch timed out');
  };
  const abortPromise = new Promise<void>((_resolve, reject) => {
    onAbort = () => reject(new Error('Remote fetch timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([validateUrl(url), abortPromise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function assertRemoteUrlPolicy(
  url: string,
  input: CreateBoundedRemoteJsonFetcherInput,
  validateUrl: (url: string) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Remote URL must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Remote URL must not include credentials');
  }
  if (parsed.hash) {
    throw new Error('Remote URL must not include a fragment');
  }
  assertHostnameAllowed(parsed.hostname, input.isDomainBlocked);
  assertNotCanonicalRemoteOrigin(url, input.canonicalOrigin);
  await validateUrlWithDeadline(validateUrl, url, signal);
}

async function fetchWithRedirects(
  url: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  validateUrl: (url: string) => Promise<void>,
  input: CreateBoundedRemoteJsonFetcherInput,
): Promise<{ response: Response; finalUrl: string }> {
  let current = url;
  for (let redirectCount = 0; redirectCount <= REMOTE_FETCH_MAX_REDIRECTS; redirectCount += 1) {
    await assertRemoteUrlPolicy(current, input, validateUrl, signal);
    const response = await fetchImpl(current, {
      method: 'GET',
      headers: { Accept: 'application/activity+json, application/ld+json' },
      redirect: 'manual',
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('Redirect missing location');
      }
      current = new URL(location, current).toString();
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error('Too many redirects');
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new Error('Remote response exceeds size limit');
    }
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error('Remote response exceeds size limit');
    }
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Remote response exceeds size limit');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function isJsonObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Creates a bounded remote JSON fetcher with shared redirect and policy checks. */
export function createBoundedRemoteJsonFetcher(
  input: CreateBoundedRemoteJsonFetcherInput,
): BoundedRemoteJsonFetcher {
  return {
    async fetchJsonDocument(url: string) {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), REMOTE_FETCH_TOTAL_TIMEOUT_MS);
      try {
        const validateUrl = input.validateUrl ?? validatePublicUrl;
        const { response, finalUrl } = await fetchWithRedirects(
          url,
          input.fetch,
          controller.signal,
          validateUrl,
          input,
        );
        if (!response.ok) {
          throw new Error('Remote document fetch failed');
        }
        const bytes = await readBoundedBody(response, REMOTE_FETCH_MAX_RESPONSE_BYTES);
        const text = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(text) as unknown;
        if (!isJsonObjectRecord(parsed)) {
          throw new Error('Remote document is not a JSON object');
        }
        return { document: parsed, finalUrl };
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

/** Parses ACTIVITYPUB_BLOCKED_DOMAINS comma-separated env into a blocked-domain predicate. */
export function createBlockedDomainPredicateFromList(
  blockedDomains: readonly string[],
): BlockedDomainPredicate {
  const normalized = blockedDomains
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return (hostname) => isHostnameBlocked(hostname, normalized);
}
