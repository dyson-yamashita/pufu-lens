import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createActivityPubProductionRuntime,
  createActivityPubWebRuntime,
  resolveActivityPubCanonicalOrigin,
  resolveActivityPubProductionConfig,
} from './activitypub-runtime.ts';

const configuredOrigin = 'https://lens.test';
const encryptionKey = Buffer.alloc(32, 2).toString('base64');

test('resolveActivityPubCanonicalOrigin uses explicit env/input instead of untrusted Host', () => {
  assert.equal(
    resolveActivityPubCanonicalOrigin({
      configuredOrigin,
      requestHost: 'evil.example',
    }),
    configuredOrigin,
  );
  assert.throws(
    () =>
      resolveActivityPubCanonicalOrigin({
        requestHost: 'evil.example',
      }),
    /canonical origin/i,
  );
});

test('resolveActivityPubCanonicalOrigin normalizes equivalent HTTPS origins', () => {
  assert.equal(
    resolveActivityPubCanonicalOrigin({
      configuredOrigin: 'https://LENS.TEST:443/',
    }),
    'https://lens.test',
  );
});

test('createActivityPubWebRuntime exposes Node-runtime-compatible proxy convention', async () => {
  const runtime = await createActivityPubWebRuntime({
    canonicalOrigin: configuredOrigin,
    manuallyStartQueue: true,
  });

  assert.equal(runtime.runtime, 'nodejs');
  assert.equal(runtime.proxyConvention, 'next-16-node-runtime');
  assert.equal(typeof runtime.handleRequest, 'function');
});

test('createActivityPubWebRuntime does not start a queue consumer during construction or requests', async () => {
  const calls: string[] = [];
  const runtime = await createActivityPubWebRuntime({
    canonicalOrigin: configuredOrigin,
    manuallyStartQueue: true,
    queueHooks: {
      listen: () => {
        calls.push('listen');
      },
      startQueue: () => {
        calls.push('startQueue');
      },
      processQueuedTask: () => {
        calls.push('processQueuedTask');
      },
    },
  });

  await runtime.handleRequest(
    new Request(`${configuredOrigin}/.well-known/webfinger?resource=acct:pufu@lens.test`, {
      headers: {
        Host: 'evil.example',
      },
    }),
  );

  assert.deepEqual(calls, []);
});

test('resolveActivityPubProductionConfig validates required production env values', () => {
  assert.throws(
    () =>
      resolveActivityPubProductionConfig({
        databaseUrl: 'postgresql://example',
        canonicalOrigin: configuredOrigin,
        encryptionKey: Buffer.alloc(16).toString('base64'),
      }),
    /32 bytes/,
  );
  const config = resolveActivityPubProductionConfig({
    databaseUrl: 'postgresql://example',
    canonicalOrigin: configuredOrigin,
    encryptionKey,
  });
  assert.equal(config.canonicalOrigin, configuredOrigin);
  assert.equal(config.encryptionKey.length, 32);
});

test('createActivityPubProductionRuntime does not start queue consumers during construction', async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      createActivityPubProductionRuntime({
        databaseUrl: 'postgresql://invalid:5432/invalid',
        canonicalOrigin: configuredOrigin,
        encryptionKey,
        queueHooks: {
          listen: () => calls.push('listen'),
          startQueue: () => calls.push('startQueue'),
          processQueuedTask: () => calls.push('processQueuedTask'),
        },
      }),
    /(connect|ECONNREFUSED|getaddrinfo|Invalid|failed)/i,
  );
  assert.deepEqual(calls, []);
});
