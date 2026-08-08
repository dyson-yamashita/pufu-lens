import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createActivityPubWebRuntime,
  resolveActivityPubCanonicalOrigin,
} from './activitypub-runtime.ts';

const configuredOrigin = 'https://lens.test';

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
