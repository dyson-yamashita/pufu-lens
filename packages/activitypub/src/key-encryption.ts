import { createCipheriv, createDecipheriv, randomBytes, type webcrypto } from 'node:crypto';

const ENCRYPTION_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type EncryptedPrivateKeyBlob = {
  readonly version: typeof ENCRYPTION_VERSION;
  readonly algorithm: typeof ALGORITHM;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
};

type JsonWebKey = webcrypto.JsonWebKey;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertEncryptionKeyLength(encryptionKey: Buffer): void {
  if (encryptionKey.length !== KEY_BYTES) {
    throw new Error('Invalid actor key encryption key length');
  }
}

/** Decodes strict canonical base64 without accepting ignored invalid characters. */
export function decodeStrictBase64(value: string): Buffer {
  const normalized = value.replace(/\s/g, '');
  if (!BASE64_PATTERN.test(normalized) || normalized.length === 0) {
    throw new Error('ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY must be valid base64');
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.toString('base64') !== normalized) {
    throw new Error('ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY must be canonical base64');
  }
  return decoded;
}

/** Parses a base64-encoded 32-byte actor key encryption key from configuration. */
export function parseActorKeyEncryptionKey(value: string | undefined): Buffer {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error('ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY is required');
  }

  const decoded = decodeStrictBase64(trimmed);
  if (decoded.length !== KEY_BYTES) {
    throw new Error('ACTIVITYPUB_ACTOR_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }

  return decoded;
}

/** Encrypts a private JWK into a versioned JSON blob for PostgreSQL storage. */
export function encryptPrivateJwk(input: {
  privateJwk: JsonWebKey;
  encryptionKey: Buffer;
}): EncryptedPrivateKeyBlob {
  assertEncryptionKeyLength(input.encryptionKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, input.encryptionKey, iv);
  const plaintext = Buffer.from(JSON.stringify(input.privateJwk), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: ENCRYPTION_VERSION,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/** Decrypts a stored private JWK blob without logging sensitive material. */
export function decryptPrivateJwk(input: {
  encrypted: unknown;
  encryptionKey: Buffer;
}): JsonWebKey {
  assertEncryptionKeyLength(input.encryptionKey);
  const blob = parseEncryptedPrivateKeyBlob(input.encrypted);
  if (blob.version !== ENCRYPTION_VERSION || blob.algorithm !== ALGORITHM) {
    throw new Error('Unsupported encrypted private key format');
  }

  const iv = Buffer.from(blob.iv, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Invalid encrypted private key blob');
  }

  const decipher = createDecipheriv(ALGORITHM, input.encryptionKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const parsed: unknown = JSON.parse(plaintext);
  if (!isRecord(parsed)) {
    throw new Error('Decrypted private key is not a JSON object');
  }
  return parsed as JsonWebKey;
}

function parseEncryptedPrivateKeyBlob(value: unknown): EncryptedPrivateKeyBlob {
  if (!isRecord(value)) {
    throw new Error('Invalid encrypted private key blob');
  }
  const version = value.version;
  const algorithm = value.algorithm;
  const iv = value.iv;
  const ciphertext = value.ciphertext;
  const tag = value.tag;
  if (
    version !== ENCRYPTION_VERSION ||
    algorithm !== ALGORITHM ||
    typeof iv !== 'string' ||
    typeof ciphertext !== 'string' ||
    typeof tag !== 'string'
  ) {
    throw new Error('Invalid encrypted private key blob');
  }
  return {
    version: ENCRYPTION_VERSION,
    algorithm: ALGORITHM,
    iv,
    ciphertext,
    tag,
  };
}
