import assert from 'node:assert/strict';
import test from 'node:test';
import { exportJwk, generateCryptoKeyPair } from '@fedify/fedify';
import { createPostgresActivityPubRepository } from './actor-repository.ts';
import {
  decryptPrivateJwk,
  encryptPrivateJwk,
  parseActorKeyEncryptionKey,
} from './key-encryption.ts';

const encryptionKey = Buffer.alloc(32, 7);

test('parseActorKeyEncryptionKey rejects noncanonical base64', () => {
  const unpadded = Buffer.alloc(32, 3).toString('base64').replace(/=+$/, '');
  assert.throws(() => parseActorKeyEncryptionKey(unpadded), /base64/i);
  assert.throws(() => parseActorKeyEncryptionKey('@@@'), /base64/i);
  const paddedWithExtra = `${Buffer.alloc(32, 3).toString('base64')}=`;
  assert.throws(() => parseActorKeyEncryptionKey(paddedWithExtra), /base64/i);
});

test('encryptPrivateJwk round-trips a private JWK', async () => {
  const keyPair = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5');
  const privateJwk = await exportJwk(keyPair.privateKey);
  const encrypted = encryptPrivateJwk({ privateJwk, encryptionKey });
  const decrypted = decryptPrivateJwk({ encrypted, encryptionKey });
  assert.equal(decrypted.kty, privateJwk.kty);
});

test('actor key material generation does not log private secrets', async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    const keyPair = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5');
    const privateJwk = await exportJwk(keyPair.privateKey);
    const encrypted = encryptPrivateJwk({ privateJwk, encryptionKey });
    decryptPrivateJwk({ encrypted, encryptionKey });
    const repository = createPostgresActivityPubRepository({
      sql: createThrowingSql(),
      encryptionKey,
    });
    await assert.rejects(() => repository.importActorCryptoKeyPair('missing'), /not found/i);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  const joined = logs.join('\n');
  for (const sentinel of [
    '"d":',
    'BEGIN PRIVATE KEY',
    '"ciphertext":',
    'Signature-Input',
    'ACTIVITYPUB_ACTOR_KEY',
  ]) {
    assert.equal(joined.includes(sentinel), false, `unexpected secret sentinel: ${sentinel}`);
  }
});

function createThrowingSql(): never {
  return (async () => []) as never;
}
