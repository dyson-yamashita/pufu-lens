import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITYPUB_INBOX_AUTHENTICATION_FAILURE_EVENT,
  ACTIVITYPUB_REQUEST_EVENT,
  classifyActivityPubProxyRouteKind,
  emitActivityPubInboxAuthenticationFailure,
  emitActivityPubRequestObservability,
  observeActivityPubProxyHandler,
} from './activitypub-proxy.ts';

const secretQuery = 'token=super-secret-token';
const actorId = 'acct:alice@lens.test';

function captureConsoleLog(run: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (value?: unknown) => {
    lines.push(String(value));
  };
  return Promise.resolve()
    .then(run)
    .then(() => lines)
    .finally(() => {
      console.log = original;
    });
}

test('captureConsoleLog restores console.log after synchronous throws', async () => {
  const original = console.log;
  await assert.rejects(
    () =>
      captureConsoleLog(() => {
        throw new Error('sync throw');
      }),
    /sync throw/,
  );
  assert.equal(console.log, original);
});

test('classifyActivityPubProxyRouteKind normalizes federation routes without exposing identifiers', () => {
  assert.equal(
    classifyActivityPubProxyRouteKind(
      new Request(`https://lens.test/.well-known/webfinger?resource=${actorId}`),
    ),
    'webfinger',
  );
  assert.equal(
    classifyActivityPubProxyRouteKind(new Request('https://lens.test/activitypub/inbox')),
    'shared_inbox',
  );
  assert.equal(
    classifyActivityPubProxyRouteKind(
      new Request(`https://lens.test/activitypub/actors/pufu/inbox?${secretQuery}`),
    ),
    'inbox',
  );
  assert.equal(
    classifyActivityPubProxyRouteKind(new Request('https://lens.test/activitypub/actors/pufu')),
    'actor',
  );
  assert.equal(
    classifyActivityPubProxyRouteKind(
      new Request('https://lens.test/activitypub/reports/report-1'),
    ),
    'report',
  );
});

test('emitActivityPubRequestObservability never logs host path query headers or body fields', () => {
  const lines = captureConsoleLog(() => {
    emitActivityPubRequestObservability({
      routeKind: 'inbox',
      method: 'POST',
      status: 401,
    });
  });

  return lines.then((resolved) => {
    assert.equal(resolved.length, 1);
    const payload = JSON.parse(resolved[0] as string) as Record<string, unknown>;
    assert.equal(payload.event, ACTIVITYPUB_REQUEST_EVENT);
    assert.equal(payload.bodyless, true);
    assert.equal(payload.routeKind, 'inbox');
    assert.equal(Object.hasOwn(payload, 'host'), false);
    assert.equal(Object.hasOwn(payload, 'path'), false);
    assert.equal(Object.hasOwn(payload, 'query'), false);
    assert.equal(Object.hasOwn(payload, 'body'), false);
    assert.equal(Object.hasOwn(payload, 'signature'), false);
  });
});

test('emitActivityPubInboxAuthenticationFailure only emits route kind and status', async () => {
  const lines = await captureConsoleLog(() => {
    emitActivityPubInboxAuthenticationFailure({ routeKind: 'shared_inbox', status: 403 });
  });

  const payload = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(payload.event, ACTIVITYPUB_INBOX_AUTHENTICATION_FAILURE_EVENT);
  assert.deepEqual(Object.keys(payload).sort(), [
    'bodyless',
    'event',
    'routeKind',
    'schemaVersion',
    'status',
  ]);
});

test('observeActivityPubProxyHandler emits status 500 and rethrows handler errors without leaking details', async () => {
  const request = new Request(`https://lens.test/activitypub/actors/pufu/inbox?${secretQuery}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer secret-token' },
    body: '{"actor":"https://evil.example/users/alice"}',
  });
  const error = new Error('signature verification failed for secret-token');

  const lines = await captureConsoleLog(async () => {
    await assert.rejects(
      () =>
        observeActivityPubProxyHandler(request, async () => {
          throw error;
        }),
      (thrown: unknown) => thrown === error,
    );
  });

  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(payload.event, ACTIVITYPUB_REQUEST_EVENT);
  assert.equal(payload.status, 500);
  assert.equal(payload.routeKind, 'inbox');
  assert.equal(JSON.stringify(payload).includes('secret-token'), false);
  assert.equal(JSON.stringify(payload).includes('signature verification failed'), false);
});

test('observeActivityPubProxyHandler emits status 500 when resolver closure throws before handler runs', async () => {
  const request = new Request('https://lens.test/activitypub/inbox', { method: 'POST' });
  const error = new Error('createProductionFederation is required when ACTIVITYPUB_ENABLED=1');

  const lines = await captureConsoleLog(async () => {
    await assert.rejects(
      () => observeActivityPubProxyHandler(request, () => Promise.reject(error)),
      (thrown: unknown) => thrown === error,
    );
  });

  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(payload.event, ACTIVITYPUB_REQUEST_EVENT);
  assert.equal(payload.status, 500);
  assert.equal(payload.routeKind, 'shared_inbox');
  assert.equal(JSON.stringify(payload).includes('createProductionFederation'), false);
});

test('observeActivityPubProxyHandler emits inbox authentication failure only for POST 401/403', async () => {
  const request = new Request('https://lens.test/activitypub/inbox', { method: 'POST' });
  const lines = await captureConsoleLog(async () => {
    const response = await observeActivityPubProxyHandler(
      request,
      async () => new Response(null, { status: 403 }),
    );
    assert.equal(response.status, 403);
  });

  assert.equal(lines.length, 2);
  const requestEvent = JSON.parse(lines[0] as string) as Record<string, unknown>;
  const authEvent = JSON.parse(lines[1] as string) as Record<string, unknown>;
  assert.equal(requestEvent.event, ACTIVITYPUB_REQUEST_EVENT);
  assert.equal(authEvent.event, ACTIVITYPUB_INBOX_AUTHENTICATION_FAILURE_EVENT);
});
