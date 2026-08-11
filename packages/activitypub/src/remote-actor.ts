import { isActor } from '@fedify/vocab';
import { validatePublicUrl } from '@fedify/vocab-runtime';
import { parseCanonicalOrigin } from './canonical-origin.ts';
import { assertHttpsActivityPubUrl } from './follow-model.ts';
import {
  type BlockedDomainPredicate,
  type CreateBoundedRemoteJsonFetcherInput,
  createBoundedRemoteJsonFetcher,
} from './remote-document.ts';

/** Resolved remote actor endpoints for outbound federation. */
export type RemoteActorReadModel = {
  readonly actorUri: string;
  readonly inboxUri: string;
  readonly sharedInboxUri: string | null;
};

export type { BlockedDomainPredicate };

const MAX_INPUT_LENGTH = 512;

/** Input for creating a remote actor resolver with injected network boundaries. */
export type CreateRemoteActorResolverInput = CreateBoundedRemoteJsonFetcherInput;

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

async function resolveRemoteActor(
  rawInput: string,
  input: CreateRemoteActorResolverInput,
): Promise<RemoteActorReadModel> {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) {
    throw new Error('Invalid remote actor input length');
  }

  const fetcher = createBoundedRemoteJsonFetcher(input);
  const validateUrl = input.validateUrl ?? validatePublicUrl;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  try {
    if (trimmed.startsWith('https://')) {
      const url = assertHttpsActivityPubUrl(trimmed, 'actor');
      await assertRemoteUrlPolicy(url, input, validateUrl, controller.signal);
      assertNotCanonicalRemoteOrigin(url, input.canonicalOrigin);
      const { document, finalUrl } = await fetcher.fetchJsonDocument(url);
      return parseActorDocument(document, input, validateUrl, controller.signal, finalUrl);
    }

    const handle = parseHandle(trimmed);
    const expectedSubject = `acct:${handle.user}@${handle.host}`;
    const webfingerUrl = `https://${handle.host}/.well-known/webfinger?resource=${encodeURIComponent(
      expectedSubject,
    )}`;
    await assertRemoteUrlPolicy(webfingerUrl, input, validateUrl, controller.signal);
    const webfinger = await fetcher.fetchJsonDocument(webfingerUrl);
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
      await assertRemoteUrlPolicy(href, input, validateUrl, controller.signal);
      const actorDocument = await fetcher.fetchJsonDocument(href);
      return parseActorDocument(
        actorDocument.document,
        input,
        validateUrl,
        controller.signal,
        actorDocument.finalUrl,
      );
    }
    throw new Error('WebFinger self ActivityPub link not found');
  } finally {
    clearTimeout(deadline);
  }
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
