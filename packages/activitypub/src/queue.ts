import type { webcrypto } from 'node:crypto';
import type { Message, MessageQueue, MessageQueueEnqueueOptions } from '@fedify/fedify';
import { createActivityPubWebFederation } from './protocol.ts';

type JsonWebKey = webcrypto.JsonWebKey;

const PRIVATE_JWK_PROPERTIES = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'] as const;
const MAX_QUEUE_PAYLOAD_BYTES = 256 * 1024;

export type PinnedOutboxMessage = {
  type: 'outbox';
  id: string;
  baseUrl: string;
  keys: ReadonlyArray<{
    keyId: string;
    privateKey?: JsonWebKey;
  }>;
  activity: unknown;
  activityId?: string;
  activityType: string;
  inbox: string;
  sharedInbox: boolean;
  actorIds?: readonly string[];
  started: string;
  attempt: number;
  headers: Readonly<Record<string, string>>;
  orderingKey?: string;
  traceContext: Readonly<Record<string, string>>;
};

/** Pinned Fedify 2.3.4 inbox message accepted at the Step 3 queue boundary. */
export type PinnedInboxMessage = {
  type: 'inbox';
  id: string;
  baseUrl: string;
  activity: unknown;
  normalizedActivity?: unknown;
  ldSignatureVerified?: boolean;
  identifier: string | null;
  started: string;
  attempt: number;
  traceContext: Readonly<Record<string, string>>;
};

/** Union of queue messages persisted by the PostgreSQL adapter. */
export type PinnedQueueMessage = PinnedOutboxMessage | PinnedInboxMessage;

/** Redacted outbox payload persisted in PostgreSQL without private JWK material. */
export type StoredOutboxMessage = Omit<PinnedOutboxMessage, 'keys'> & {
  keys: ReadonlyArray<{ keyId: string }>;
};

/** Redacted inbox payload persisted in PostgreSQL without signature headers or keys. */
export type StoredInboxMessage = PinnedInboxMessage;

/** Union of stored queue payloads for inbox and outbox rows. */
export type StoredQueueMessage = StoredOutboxMessage | StoredInboxMessage;

export class UnsupportedFedifyQueueMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFedifyQueueMessageError';
  }
}

/** PostgreSQL queue enqueue options supported by the Step 1 adapter. */
export type PostgresQueueEnqueueOptions = MessageQueueEnqueueOptions & {
  dedupeKey?: string;
};

type InMemoryQueueOptions = {
  onProcess?: (message: PinnedOutboxMessage) => Promise<{ success: boolean }>;
};

type QueueHookRecorder = {
  listen?: () => void;
  startQueue?: () => void;
  processQueuedTask?: () => void;
};

/** Builds a deterministic inbox dedupe key from the Activity id. */
export function buildInboxDedupeKey(input: { activityId: string }): string {
  return normalizeHttpsUrl(input.activityId, 'activityId');
}

/** Builds a deterministic dedupe key from activity and recipient inbox URLs. */
export function buildOutboxDedupeKey(input: {
  activityId: string;
  recipientInbox: string;
}): string {
  const activityId = normalizeHttpUrl(input.activityId, 'activityId');
  const recipientInbox = normalizeHttpUrl(input.recipientInbox, 'recipientInbox');
  return `${activityId}|${recipientInbox}`;
}

/** Redacts private JWK members from a pinned outbox message for PostgreSQL storage. */
export function redactFedifyQueueMessageForStorage(
  message: unknown,
): StoredOutboxMessage | StoredInboxMessage {
  if (
    message &&
    typeof message === 'object' &&
    (message as Record<string, unknown>).type === 'inbox'
  ) {
    return parsePinnedInboxMessage(message);
  }
  const parsed = parsePinnedOutboxMessage(message, { requirePrivateKeys: true });
  return {
    ...parsed,
    keys: parsed.keys.map((key) => ({ keyId: key.keyId })),
  };
}

/** Parses a stored queue payload back into the supported inbox or outbox shape. */
export function parseStoredQueueMessage(message: unknown): StoredQueueMessage {
  if (
    message &&
    typeof message === 'object' &&
    (message as Record<string, unknown>).type === 'inbox'
  ) {
    return parsePinnedInboxMessage(message);
  }
  const parsed = parsePinnedOutboxMessage(message, { requirePrivateKeys: false });
  return {
    ...parsed,
    keys: parsed.keys.map((key) => ({ keyId: key.keyId })),
  };
}

/** Rehydrates a stored outbox message with private JWK material resolved by key ID. */
export async function rehydrateStoredOutboxMessage(
  message: StoredOutboxMessage,
  resolvePrivateKey: (keyId: string) => Promise<JsonWebKey>,
): Promise<PinnedOutboxMessage> {
  const keys = await Promise.all(
    message.keys.map(async (key) => {
      const privateKey = await resolvePrivateKey(key.keyId);
      assertPrivateJwk(privateKey, key.keyId);
      return {
        keyId: key.keyId,
        privateKey,
      };
    }),
  );

  return {
    ...message,
    keys,
  };
}

/** Creates a test-only in-memory queue adapter with native retry enabled. Yields at most one queued message. */
export function createInMemoryQueueAdapter(options: InMemoryQueueOptions = {}) {
  const pending: PinnedOutboxMessage[] = [];
  let claimedOnce = false;

  const queue: MessageQueue & {
    enqueue(message: unknown, options?: MessageQueueEnqueueOptions): Promise<void>;
    claim(): Promise<PinnedOutboxMessage | null>;
  } = {
    nativeRetrial: true,
    async enqueue(message: unknown, enqueueOptions?: MessageQueueEnqueueOptions) {
      const parsed = parsePinnedOutboxMessage(message, { requirePrivateKeys: true });
      if (
        enqueueOptions?.orderingKey &&
        parsed.orderingKey &&
        enqueueOptions.orderingKey !== parsed.orderingKey
      ) {
        throw new UnsupportedFedifyQueueMessageError(
          'orderingKey conflict between enqueue options and message',
        );
      }
      pending.push({
        ...parsed,
        orderingKey: enqueueOptions?.orderingKey ?? parsed.orderingKey,
      });
    },
    async listen() {
      throw new Error('in-memory queue does not support listen()');
    },
    async claim(): Promise<PinnedOutboxMessage | null> {
      if (claimedOnce || pending.length === 0) {
        return null;
      }
      claimedOnce = true;
      const [next] = pending.splice(0, 1);
      if (!next) {
        return null;
      }
      if (options.onProcess) {
        const result = await options.onProcess(next);
        if (!result.success) {
          throw new UnsupportedFedifyQueueMessageError(
            'in-memory queue onProcess reported failure',
          );
        }
      }
      return next;
    },
  };

  return queue;
}

/** Returns at most one queued message from the in-memory one-shot adapter. */
export async function claimOneQueueMessage(
  adapter: ReturnType<typeof createInMemoryQueueAdapter>,
): Promise<PinnedOutboxMessage | null> {
  return adapter.claim();
}

/** Creates a manually started Fedify instance that never starts queue consumers. */
export async function createWebFederationWithoutQueueConsumer(input: {
  canonicalOrigin: string;
  queueHooks?: QueueHookRecorder;
}) {
  return createActivityPubWebFederation(input);
}

/** Redacts an inbox message for PostgreSQL storage and enforces payload size limits. */
export function redactFedifyInboxMessageForStorage(message: unknown): StoredInboxMessage {
  return parsePinnedInboxMessage(message);
}

/** Parses a stored inbox queue payload. */
export function parseStoredInboxMessage(message: unknown): StoredInboxMessage {
  return parsePinnedInboxMessage(message);
}

/** Parses and validates the pinned Fedify 2.3.4 inbox message boundary. */
export function parsePinnedInboxMessage(message: unknown): StoredInboxMessage {
  if (!message || typeof message !== 'object') {
    throw new UnsupportedFedifyQueueMessageError('queue message must be an object');
  }
  const candidate = message as Record<string, unknown>;
  if (candidate.type !== 'inbox') {
    throw new UnsupportedFedifyQueueMessageError(
      `unsupported queue message type: ${String(candidate.type)}`,
    );
  }
  for (const field of ['id', 'baseUrl', 'started'] as const) {
    if (typeof candidate[field] !== 'string' || (candidate[field] as string).length === 0) {
      throw new UnsupportedFedifyQueueMessageError(`inbox message missing ${field}`);
    }
  }
  if (!candidate.activity) {
    throw new UnsupportedFedifyQueueMessageError('inbox message missing activity');
  }
  if (typeof candidate.attempt !== 'number') {
    throw new UnsupportedFedifyQueueMessageError('inbox message missing attempt');
  }
  const attempt = assertNonNegativeIntegerAttempt(candidate.attempt);
  const traceContext = assertPlainStringRecord(candidate.traceContext, 'traceContext');
  const activityId = extractHttpsActivityId(candidate.activity);
  normalizeHttpsUrl(activityId, 'activity.id');
  const identifier =
    candidate.identifier === null
      ? null
      : typeof candidate.identifier === 'string'
        ? candidate.identifier
        : (() => {
            throw new UnsupportedFedifyQueueMessageError(
              'inbox message identifier must be string or null',
            );
          })();
  const parsed: StoredInboxMessage = {
    type: 'inbox',
    id: candidate.id as string,
    baseUrl: normalizeHttpsUrl(candidate.baseUrl as string, 'baseUrl'),
    activity: candidate.activity,
    normalizedActivity: candidate.normalizedActivity,
    ldSignatureVerified:
      typeof candidate.ldSignatureVerified === 'boolean'
        ? candidate.ldSignatureVerified
        : undefined,
    identifier,
    started: candidate.started as string,
    attempt,
    traceContext,
  };
  assertQueuePayloadSize(parsed);
  return parsed;
}

/** Parses and validates the pinned Fedify 2.3.4 outbox message boundary. */
export function parsePinnedOutboxMessage(
  message: unknown,
  options: { requirePrivateKeys: boolean },
): PinnedOutboxMessage {
  if (!message || typeof message !== 'object') {
    throw new UnsupportedFedifyQueueMessageError('queue message must be an object');
  }

  const candidate = message as Record<string, unknown>;
  const type = candidate.type;
  if (type === 'fanout' || type === 'inbox') {
    throw new UnsupportedFedifyQueueMessageError(`unsupported queue message type: ${String(type)}`);
  }
  if (type !== 'outbox') {
    throw new UnsupportedFedifyQueueMessageError(`unsupported queue message type: ${String(type)}`);
  }

  const requiredStringFields = ['id', 'baseUrl', 'activityType', 'inbox', 'started'] as const;
  for (const field of requiredStringFields) {
    if (typeof candidate[field] !== 'string' || candidate[field].length === 0) {
      throw new UnsupportedFedifyQueueMessageError(`outbox message missing ${field}`);
    }
  }

  if (typeof candidate.activityId !== 'string' || candidate.activityId.length === 0) {
    throw new UnsupportedFedifyQueueMessageError('outbox message missing activityId');
  }
  if (typeof candidate.orderingKey !== 'string' || candidate.orderingKey.length === 0) {
    throw new UnsupportedFedifyQueueMessageError('outbox message missing orderingKey');
  }
  if (typeof candidate.sharedInbox !== 'boolean') {
    throw new UnsupportedFedifyQueueMessageError('outbox message missing sharedInbox');
  }
  if (typeof candidate.attempt !== 'number') {
    throw new UnsupportedFedifyQueueMessageError('outbox message missing attempt');
  }
  const attempt = assertNonNegativeIntegerAttempt(candidate.attempt);
  if (!candidate.activity) {
    throw new UnsupportedFedifyQueueMessageError('outbox message missing activity');
  }
  const headers = assertPlainStringRecord(candidate.headers, 'headers');
  const traceContext = assertPlainStringRecord(candidate.traceContext, 'traceContext');
  if (!Array.isArray(candidate.keys) || candidate.keys.length === 0) {
    throw new UnsupportedFedifyQueueMessageError('outbox message missing keys');
  }

  const baseUrl = normalizeHttpUrl(candidate.baseUrl as string, 'baseUrl');
  const activityId = normalizeHttpUrl(candidate.activityId as string, 'activityId');
  const inbox = normalizeHttpUrl(candidate.inbox as string, 'inbox');
  const orderingKey = normalizeHttpUrl(candidate.orderingKey as string, 'orderingKey');
  const actorIds = assertOptionalHttpUrlList(candidate.actorIds, 'actorIds');

  const keys = candidate.keys.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new UnsupportedFedifyQueueMessageError(`outbox message key ${index} is invalid`);
    }
    const key = entry as Record<string, unknown>;
    if (typeof key.keyId !== 'string' || key.keyId.length === 0) {
      throw new UnsupportedFedifyQueueMessageError(`outbox message key ${index} missing keyId`);
    }
    const keyId = normalizeHttpKeyIdUrl(key.keyId, `keys[${index}].keyId`);
    if (options.requirePrivateKeys) {
      if (!key.privateKey || typeof key.privateKey !== 'object') {
        throw new UnsupportedFedifyQueueMessageError(
          `outbox message key ${index} missing privateKey`,
        );
      }
      assertPrivateJwk(key.privateKey as JsonWebKey, keyId);
      return {
        keyId,
        privateKey: key.privateKey as JsonWebKey,
      };
    }
    if ('privateKey' in key) {
      throw new UnsupportedFedifyQueueMessageError(
        'stored outbox message must not include privateKey',
      );
    }
    assertNoDirectPrivateJwkProperties(key);
    return {
      keyId,
    };
  });

  const result: PinnedOutboxMessage = {
    type: 'outbox',
    id: candidate.id as string,
    baseUrl,
    keys,
    activity: candidate.activity,
    activityId,
    activityType: candidate.activityType as string,
    inbox,
    sharedInbox: candidate.sharedInbox as boolean,
    actorIds,
    started: candidate.started as string,
    attempt,
    headers,
    orderingKey,
    traceContext,
  };
  assertQueuePayloadSize(result);
  return result;
}

function extractHttpsActivityId(activity: unknown): string {
  if (!activity || typeof activity !== 'object') {
    throw new UnsupportedFedifyQueueMessageError('inbox activity must be an object');
  }
  const id = (activity as Record<string, unknown>).id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new UnsupportedFedifyQueueMessageError('inbox activity missing id');
  }
  return id;
}

function assertNonNegativeIntegerAttempt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new UnsupportedFedifyQueueMessageError(
      'outbox message attempt must be a nonnegative integer',
    );
  }
  return value;
}

function assertPlainStringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnsupportedFedifyQueueMessageError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') {
      throw new UnsupportedFedifyQueueMessageError(`${label}.${key} must be a string`);
    }
  }
  return record as Readonly<Record<string, string>>;
}

function assertOptionalHttpUrlList(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new UnsupportedFedifyQueueMessageError(`${label} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new UnsupportedFedifyQueueMessageError(`${label}[${index}] must be a string`);
    }
    return normalizeHttpsUrl(entry, `${label}[${index}]`);
  });
}

function assertNoDirectPrivateJwkProperties(value: Record<string, unknown>): void {
  for (const property of PRIVATE_JWK_PROPERTIES) {
    if (property in value) {
      throw new UnsupportedFedifyQueueMessageError(
        `stored outbox message must not include private JWK property ${property}`,
      );
    }
  }
}

function normalizeHttpUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UnsupportedFedifyQueueMessageError(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsupportedFedifyQueueMessageError(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new UnsupportedFedifyQueueMessageError(
      `${label} must not include credentials or fragments`,
    );
  }
  return parsed.toString();
}

/** Validates HTTPS-only URLs for production federation queue boundaries. */
function normalizeHttpsUrl(value: string, label: string): string {
  const normalized = normalizeHttpUrl(value, label);
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'https:') {
    throw new UnsupportedFedifyQueueMessageError(`${label} must use HTTPS`);
  }
  return normalized;
}

function assertQueuePayloadSize(message: StoredOutboxMessage | StoredInboxMessage): void {
  const size = Buffer.byteLength(JSON.stringify(message), 'utf8');
  if (size > MAX_QUEUE_PAYLOAD_BYTES) {
    throw new UnsupportedFedifyQueueMessageError('queue message exceeds serialized payload limit');
  }
}

/** Validates HTTP(S) signature key IDs, preserving URL fragments such as `#main-key`. */
function normalizeHttpKeyIdUrl(value: string, label: string): string {
  if (value.length === 0) {
    throw new UnsupportedFedifyQueueMessageError(`${label} must be a valid URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UnsupportedFedifyQueueMessageError(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsupportedFedifyQueueMessageError(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new UnsupportedFedifyQueueMessageError(`${label} must not include credentials`);
  }
  return parsed.toString();
}

function assertPrivateJwk(privateKey: JsonWebKey, keyId: string): void {
  if (privateKey.kty !== 'RSA' && privateKey.kty !== 'OKP' && privateKey.kty !== 'EC') {
    throw new UnsupportedFedifyQueueMessageError(`unsupported private key type for ${keyId}`);
  }
  if (!privateKey.d) {
    throw new UnsupportedFedifyQueueMessageError(
      `resolved private key for ${keyId} is not a private JWK`,
    );
  }
}

/** Ensures serialized queue JSON does not contain private JWK members. */
export function assertStoredMessageHasNoPrivateJwk(messageJson: unknown): void {
  const serialized = JSON.stringify(messageJson);
  for (const property of PRIVATE_JWK_PROPERTIES) {
    if (serialized.includes(`"${property}"`)) {
      throw new Error(`stored queue message must not include private JWK property ${property}`);
    }
  }
}

/** Converts a pinned queue message into Fedify's opaque queue message type. */
export function toFedifyMessage(message: PinnedOutboxMessage | PinnedInboxMessage): Message {
  return message as Message;
}
