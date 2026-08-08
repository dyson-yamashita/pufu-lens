import { isActor } from '@fedify/vocab';
import { validatePublicUrl } from '@fedify/vocab-runtime';
import { parseCanonicalOrigin } from './canonical-origin.ts';
import { assertHttpsActivityPubUrl } from './follow-model.ts';

/** Resolved remote actor endpoints for outbound federation. */
export type RemoteActorReadModel = {
  readonly actorUri: string;
  readonly inboxUri: string;
  readonly sharedInboxUri: string | null;
};

/** Predicate that blocks federation to specific hostnames. */
export type BlockedDomainPredicate = (hostname: string) => boolean;

const MAX_INPUT_LENGTH = 512;
const MAX_REDIRECTS = 5;
const TOTAL_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

type FetchLike = typeof fetch;

/** Input for creating a remote actor resolver with injected network boundaries. */
export type CreateRemoteActorResolverInput = {
  canonicalOrigin: string;
  fetch: FetchLike;
  isDomainBlocked: BlockedDomainPredicate;
  /** Hermetic tests inject a no-op URL validator to avoid DNS lookups. */
  validateUrl?: (url: string) => Promise<void>;
};

/** Remote actor resolver for WebFinger and Actor document lookup. */
export type RemoteActorResolver = {
  resolve(input: string): Promise<RemoteActorReadModel>;
};

/** Parses ACTIVITYPUB_BLOCKED_DOMAINS comma-separated env into a blocked-domain predicate. */
export function parseBlockedDomainsFromEnv(value: string | undefined): BlockedDomainPredicate {
  if (!value?.trim()) {
    return () => false;
  }
  const blocked = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return (hostname) => isHostnameBlocked(hostname, blocked);
}

function isHostnameBlocked(hostname: string, blockedDomains: readonly string[]): boolean {
  const normalized = hostname.toLowerCase();
  for (const blocked of blockedDomains) {
    if (normalized === blocked || normalized.endsWith(`.${blocked}`)) {
      return true;
    }
  }
  return false;
}

async function resolveRemoteActor(
  rawInput: string,
  input: CreateRemoteActorResolverInput,
): Promise<RemoteActorReadModel> {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) {
    throw new Error('Invalid remote actor input length');
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  try {
    const validateUrl = input.validateUrl ?? validatePublicUrl;
    const actorUrl = await resolveActorUrl(trimmed, input, validateUrl, controller.signal);
    assertNotCanonicalRemoteOrigin(actorUrl, input.canonicalOrigin);
    const { document, finalUrl } = await fetchJsonDocument(
      actorUrl,
      input,
      validateUrl,
      controller.signal,
    );
    return await parseActorDocument(document, input, validateUrl, controller.signal, finalUrl);
  } finally {
    clearTimeout(deadline);
  }
}

async function resolveActorUrl(
  trimmed: string,
  input: CreateRemoteActorResolverInput,
  validateUrl: (url: string) => Promise<void>,
  signal: AbortSignal,
): Promise<string> {
  if (trimmed.startsWith('https://')) {
    const url = assertHttpsActivityPubUrl(trimmed, 'actor');
    await assertRemoteUrlPolicy(url, input, validateUrl, signal);
    return url;
  }

  const handle = parseHandle(trimmed);
  const expectedSubject = `acct:${handle.user}@${handle.host}`;
  const webfingerUrl = `https://${handle.host}/.well-known/webfinger?resource=${encodeURIComponent(
    expectedSubject,
  )}`;
  await assertRemoteUrlPolicy(webfingerUrl, input, validateUrl, signal);

  const webfinger = await fetchJsonDocument(webfingerUrl, input, validateUrl, signal);
  if (
    typeof webfinger.document.subject !== 'string' ||
    webfinger.document.subject !== expectedSubject
  ) {
    throw new Error('WebFinger subject mismatch');
  }
  const links = webfinger.document.links;
  if (!Array.isArray(links)) {
    throw new Error('Invalid WebFinger document');
  }
  for (const link of links) {
    if (!link || typeof link !== 'object') {
      continue;
    }
    const record = link as Record<string, unknown>;
    if (record.rel !== 'self') {
      continue;
    }
    if (record.type !== 'application/activity+json' && record.type !== 'application/ld+json') {
      continue;
    }
    if (typeof record.href !== 'string') {
      continue;
    }
    const href = assertHttpsActivityPubUrl(record.href, 'WebFinger self link');
    await assertRemoteUrlPolicy(href, input, validateUrl, signal);
    return href;
  }
  throw new Error('WebFinger self ActivityPub link not found');
}

function parseHandle(trimmed: string): { user: string; host: string } {
  let candidate = trimmed;
  if (candidate.startsWith('acct:')) {
    candidate = candidate.slice('acct:'.length);
  }
  if (candidate.startsWith('@')) {
    candidate = candidate.slice(1);
  }
  const atIndex = candidate.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === candidate.length - 1) {
    throw new Error('Invalid remote actor handle');
  }
  const user = candidate.slice(0, atIndex);
  const host = candidate.slice(atIndex + 1);
  if (!user || !host || host.includes('/')) {
    throw new Error('Invalid remote actor handle');
  }
  return { user, host };
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
    throw new Error('Cannot subscribe to local canonical origin');
  }
}

async function assertRemoteUrlPolicy(
  url: string,
  input: CreateRemoteActorResolverInput,
  validateUrl: (url: string) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Remote URL must use HTTPS');
  }
  assertHostnameAllowed(parsed.hostname, input.isDomainBlocked);
  assertNotCanonicalRemoteOrigin(url, input.canonicalOrigin);
  await validateUrlWithDeadline(validateUrl, url, signal);
}

async function validateUrlWithDeadline(
  validateUrl: (url: string) => Promise<void>,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new Error('Remote actor resolution timed out');
  }
  let onAbort: () => void = () => {
    throw new Error('Remote actor resolution timed out');
  };
  const abortPromise = new Promise<void>((_resolve, reject) => {
    onAbort = () => reject(new Error('Remote actor resolution timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([validateUrl(url), abortPromise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function fetchJsonDocument(
  url: string,
  input: CreateRemoteActorResolverInput,
  validateUrl: (url: string) => Promise<void>,
  signal: AbortSignal,
): Promise<{ document: Record<string, unknown>; finalUrl: string }> {
  await assertRemoteUrlPolicy(url, input, validateUrl, signal);

  const { response, finalUrl } = await fetchWithRedirects(
    url,
    input.fetch,
    signal,
    validateUrl,
    input.isDomainBlocked,
    input.canonicalOrigin,
  );
  if (!response.ok) {
    throw new Error('Remote document fetch failed');
  }
  const bytes = await readBoundedBody(response, MAX_RESPONSE_BYTES);
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Remote document is not a JSON object');
  }
  return { document: parsed as Record<string, unknown>, finalUrl };
}

async function fetchWithRedirects(
  url: string,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  validateUrl: (url: string) => Promise<void>,
  isDomainBlocked: BlockedDomainPredicate,
  canonicalOrigin: string,
): Promise<{ response: Response; finalUrl: string }> {
  let current = url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'https:') {
      throw new Error('Remote URL must use HTTPS');
    }
    assertHostnameAllowed(parsed.hostname, isDomainBlocked);
    assertNotCanonicalRemoteOrigin(current, canonicalOrigin);
    await validateUrlWithDeadline(validateUrl, current, signal);
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
      const redirectTarget = new URL(location, current).toString();
      if (redirectTarget !== current) {
        await assertRemoteUrlPolicy(
          redirectTarget,
          { canonicalOrigin, fetch: fetchImpl, isDomainBlocked },
          validateUrl,
          signal,
        );
      }
      current = redirectTarget;
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error('Too many redirects');
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
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

function normalizeActorDocumentId(actorUri: string): string {
  return new URL(actorUri).toString();
}

async function parseActorDocument(
  document: Record<string, unknown>,
  input: CreateRemoteActorResolverInput,
  validateUrl: (url: string) => Promise<void>,
  signal: AbortSignal,
  expectedActorUrl: string,
): Promise<RemoteActorReadModel> {
  const actorUriValue = document.id;
  const inboxValue = document.inbox;
  const typeValue = document.type;
  const isActorDocument =
    isActor(document) ||
    (typeof typeValue === 'string' &&
      typeof actorUriValue === 'string' &&
      typeof inboxValue === 'string');
  if (!isActorDocument) {
    throw new Error('Remote document is not an Actor');
  }
  const actorUri = actorUriValue;
  const inbox = inboxValue;
  if (!actorUri || typeof actorUri !== 'string') {
    throw new Error('Remote actor missing id');
  }
  if (!inbox || typeof inbox !== 'string') {
    throw new Error('Remote actor missing inbox');
  }
  const actorUrl = assertHttpsActivityPubUrl(actorUri, 'actor id');
  if (normalizeActorDocumentId(actorUrl) !== normalizeActorDocumentId(expectedActorUrl)) {
    throw new Error('Actor document id does not match resolved URL');
  }
  const inboxUrl = assertHttpsActivityPubUrl(inbox, 'inbox');
  await assertRemoteUrlPolicy(inboxUrl, input, validateUrl, signal);

  let sharedInboxUri: string | null = null;
  const endpoints = document.endpoints as unknown;
  if (endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints)) {
    const shared = (endpoints as Record<string, unknown>).sharedInbox;
    if (typeof shared === 'string' && shared.length > 0) {
      sharedInboxUri = assertHttpsActivityPubUrl(shared, 'sharedInbox');
      await assertRemoteUrlPolicy(sharedInboxUri, input, validateUrl, signal);
    }
  }

  return {
    actorUri: actorUrl,
    inboxUri: inboxUrl,
    sharedInboxUri,
  };
}

export function createRemoteActorResolver(
  input: CreateRemoteActorResolverInput,
): RemoteActorResolver {
  return {
    resolve: (rawInput) => resolveRemoteActor(rawInput, input),
  };
}
