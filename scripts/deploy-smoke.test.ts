import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type DeploySmokeFetch,
  listMissingRemoteSmokeEnv,
  runRemoteDeploySmoke,
} from './deploy-smoke.ts';

const canonicalOrigin = 'https://lens-smoke.test';
const actorUrl = `${canonicalOrigin}/activitypub/actors/all`;
const expectedSubject = 'acct:all@lens-smoke.test';
const MAX_RESPONSE_BYTES = 1024 * 1024;

function createFetchMock(
  handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): { fetch: DeploySmokeFetch; methods: string[] } {
  const methods: string[] = [];
  const fetchMock: DeploySmokeFetch = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    methods.push(method);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const handler = handlers[url];
    if (!handler) {
      return new Response('not found', { status: 404 });
    }
    return handler(init);
  };
  return { fetch: fetchMock, methods };
}

function createPassingWebFingerHandler(): (init?: RequestInit) => Response {
  return () =>
    Response.json({
      subject: expectedSubject,
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: actorUrl,
        },
      ],
    });
}

function createSlowBodyResponse(
  init: RequestInit | undefined,
  payload: string,
  delayMs: number,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const signal = init?.signal;
      if (signal?.aborted) {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const onAbort = (): void => {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
        if (signal?.aborted) {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const REMOTE_REQUIRED_ENV = [
  'MASTRA_SERVER_URL',
  'SCHEDULER_SERVICE_ACCOUNT',
  'ACTIVITYPUB_CANONICAL_ORIGIN',
] as const;

test('remote deploy smoke does not use network when required env is missing', async () => {
  let called = false;
  const fetchMock: DeploySmokeFetch = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };

  const result = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: {
      MASTRA_SERVER_URL: 'https://mastra.test',
      SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
    },
    fetchImpl: fetchMock,
  });

  assert.equal(called, false);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.missing, ['ACTIVITYPUB_CANONICAL_ORIGIN']);
  assert.deepEqual(listMissingRemoteSmokeEnv({}), [...REMOTE_REQUIRED_ENV]);
});

test('remote deploy smoke passes WebFinger and aggregate Actor checks', async () => {
  const webfingerUrl = `${canonicalOrigin}/.well-known/webfinger?resource=${encodeURIComponent(expectedSubject)}`;
  const { fetch, methods } = createFetchMock({
    [webfingerUrl]: (init) => {
      assert.equal(new Headers(init?.headers).get('accept'), 'application/jrd+json');
      return Response.json({
        subject: expectedSubject,
        links: [
          {
            rel: 'self',
            type: 'application/activity+json',
            href: actorUrl,
          },
        ],
      });
    },
    [actorUrl]: (init) => {
      assert.equal(new Headers(init?.headers).get('accept'), 'application/activity+json');
      return Response.json({
        id: actorUrl,
        type: 'Service',
        preferredUsername: 'all',
      });
    },
  });

  const result = await runRemoteDeploySmoke({
    env: 'production',
    envVars: {
      MASTRA_SERVER_URL: 'https://mastra.test',
      SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
      ACTIVITYPUB_CANONICAL_ORIGIN: canonicalOrigin,
    },
    fetchImpl: fetch,
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(
    result.checks.map((check) => check.id),
    ['webfinger', 'aggregate_actor'],
  );
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('remote deploy smoke fails on non-200 or contract mismatch', async () => {
  const webfingerUrl = `${canonicalOrigin}/.well-known/webfinger?resource=${encodeURIComponent(expectedSubject)}`;
  const statusFailure = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: {
      MASTRA_SERVER_URL: 'https://mastra.test',
      SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
      ACTIVITYPUB_CANONICAL_ORIGIN: canonicalOrigin,
    },
    fetchImpl: createFetchMock({
      [webfingerUrl]: () => new Response('missing', { status: 404 }),
    }).fetch,
  });
  assert.equal(statusFailure.status, 'failed');
  assert.equal(statusFailure.checks[0]?.id, 'webfinger');
  assert.equal(statusFailure.checks[0]?.reason, 'unexpected_status');
  assert.equal(statusFailure.checks[0]?.httpStatus, 404);

  const contractFailure = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: {
      MASTRA_SERVER_URL: 'https://mastra.test',
      SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
      ACTIVITYPUB_CANONICAL_ORIGIN: canonicalOrigin,
    },
    fetchImpl: createFetchMock({
      [webfingerUrl]: () =>
        Response.json({
          subject: 'acct:other@lens-smoke.test',
          links: [
            {
              rel: 'self',
              type: 'application/activity+json',
              href: actorUrl,
            },
          ],
        }),
    }).fetch,
  });
  assert.equal(contractFailure.status, 'failed');
  assert.equal(contractFailure.checks[0]?.id, 'webfinger');
  assert.equal(contractFailure.checks[0]?.reason, 'subject_mismatch');
});

test('remote deploy smoke fails on invalid canonical origin', async () => {
  const result = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: {
      MASTRA_SERVER_URL: 'https://mastra.test',
      SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
      ACTIVITYPUB_CANONICAL_ORIGIN: 'http://insecure.test',
    },
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0]?.id, 'env');
  assert.equal(result.checks[0]?.reason, 'invalid_canonical_origin');
});

test('remote deploy smoke fails on self link mismatch', async () => {
  const webfingerUrl = `${canonicalOrigin}/.well-known/webfinger?resource=${encodeURIComponent(expectedSubject)}`;
  const result = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: {
      MASTRA_SERVER_URL: 'https://mastra.test',
      SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
      ACTIVITYPUB_CANONICAL_ORIGIN: canonicalOrigin,
    },
    fetchImpl: createFetchMock({
      [webfingerUrl]: () =>
        Response.json({
          subject: expectedSubject,
          links: [
            {
              rel: 'self',
              type: 'application/activity+json',
              href: `${canonicalOrigin}/activitypub/actors/wrong`,
            },
          ],
        }),
    }).fetch,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0]?.id, 'webfinger');
  assert.equal(result.checks[0]?.reason, 'self_link_mismatch');
});

test('remote deploy smoke fails on invalid JSON', async () => {
  const webfingerUrl = `${canonicalOrigin}/.well-known/webfinger?resource=${encodeURIComponent(expectedSubject)}`;
  const result = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: {
      MASTRA_SERVER_URL: 'https://mastra.test',
      SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
      ACTIVITYPUB_CANONICAL_ORIGIN: canonicalOrigin,
    },
    fetchImpl: createFetchMock({
      [webfingerUrl]: () =>
        new Response('not-json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    }).fetch,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0]?.id, 'webfinger');
  assert.equal(result.checks[0]?.reason, 'invalid_json');
});

test('remote deploy smoke fails on JSON primitive or non-object shape', async () => {
  const webfingerUrl = `${canonicalOrigin}/.well-known/webfinger?resource=${encodeURIComponent(expectedSubject)}`;
  const result = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: {
      MASTRA_SERVER_URL: 'https://mastra.test',
      SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
      ACTIVITYPUB_CANONICAL_ORIGIN: canonicalOrigin,
    },
    fetchImpl: createFetchMock({
      [webfingerUrl]: () =>
        new Response('"just-a-string"', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    }).fetch,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0]?.id, 'webfinger');
  assert.equal(result.checks[0]?.reason, 'invalid_json');
});

test('remote deploy smoke times out while reading response body', async () => {
  const webfingerUrl = `${canonicalOrigin}/.well-known/webfinger?resource=${encodeURIComponent(expectedSubject)}`;
  const result = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: {
      MASTRA_SERVER_URL: 'https://mastra.test',
      SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
      ACTIVITYPUB_CANONICAL_ORIGIN: canonicalOrigin,
    },
    fetchImpl: createFetchMock({
      [webfingerUrl]: (init) => createSlowBodyResponse(init, '{}', 200),
    }).fetch,
    timeoutMs: 50,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0]?.id, 'webfinger');
  assert.equal(result.checks[0]?.reason, 'request_timeout');
});

test('remote deploy smoke fails aggregate actor contract mismatches', async () => {
  const webfingerUrl = `${canonicalOrigin}/.well-known/webfinger?resource=${encodeURIComponent(expectedSubject)}`;
  const baseEnv = {
    MASTRA_SERVER_URL: 'https://mastra.test',
    SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
    ACTIVITYPUB_CANONICAL_ORIGIN: canonicalOrigin,
  };

  const idMismatch = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: baseEnv,
    fetchImpl: createFetchMock({
      [webfingerUrl]: createPassingWebFingerHandler(),
      [actorUrl]: () =>
        Response.json({
          id: `${canonicalOrigin}/activitypub/actors/wrong`,
          type: 'Service',
          preferredUsername: 'all',
        }),
    }).fetch,
  });
  assert.equal(idMismatch.status, 'failed');
  assert.equal(idMismatch.checks[1]?.id, 'aggregate_actor');
  assert.equal(idMismatch.checks[1]?.reason, 'id_mismatch');

  const usernameMismatch = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: baseEnv,
    fetchImpl: createFetchMock({
      [webfingerUrl]: createPassingWebFingerHandler(),
      [actorUrl]: () =>
        Response.json({
          id: actorUrl,
          type: 'Service',
          preferredUsername: 'wrong',
        }),
    }).fetch,
  });
  assert.equal(usernameMismatch.status, 'failed');
  assert.equal(usernameMismatch.checks[1]?.id, 'aggregate_actor');
  assert.equal(usernameMismatch.checks[1]?.reason, 'preferred_username_mismatch');

  const invalidType = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: baseEnv,
    fetchImpl: createFetchMock({
      [webfingerUrl]: createPassingWebFingerHandler(),
      [actorUrl]: () =>
        Response.json({
          id: actorUrl,
          type: 'Note',
          preferredUsername: 'all',
        }),
    }).fetch,
  });
  assert.equal(invalidType.status, 'failed');
  assert.equal(invalidType.checks[1]?.id, 'aggregate_actor');
  assert.equal(invalidType.checks[1]?.reason, 'invalid_actor_type');
});

test('remote deploy smoke rejects oversized Content-Length and streamed bodies', async () => {
  const webfingerUrl = `${canonicalOrigin}/.well-known/webfinger?resource=${encodeURIComponent(expectedSubject)}`;
  const baseEnv = {
    MASTRA_SERVER_URL: 'https://mastra.test',
    SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
    ACTIVITYPUB_CANONICAL_ORIGIN: canonicalOrigin,
  };

  const oversizedHeader = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: baseEnv,
    fetchImpl: createFetchMock({
      [webfingerUrl]: () =>
        new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(MAX_RESPONSE_BYTES + 1),
          },
        }),
    }).fetch,
  });
  assert.equal(oversizedHeader.status, 'failed');
  assert.equal(oversizedHeader.checks[0]?.id, 'webfinger');
  assert.equal(oversizedHeader.checks[0]?.reason, 'response_too_large');
  assert.doesNotMatch(JSON.stringify(oversizedHeader), /lens-smoke\.test/);

  const oversizedStream = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: baseEnv,
    fetchImpl: createFetchMock({
      [webfingerUrl]: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
    }).fetch,
  });
  assert.equal(oversizedStream.status, 'failed');
  assert.equal(oversizedStream.checks[0]?.id, 'webfinger');
  assert.equal(oversizedStream.checks[0]?.reason, 'response_too_large');
  assert.doesNotMatch(JSON.stringify(oversizedStream), /lens-smoke\.test/);
});

test('remote deploy smoke never uses POST', async () => {
  const webfingerUrl = `${canonicalOrigin}/.well-known/webfinger?resource=${encodeURIComponent(expectedSubject)}`;
  const { fetch, methods } = createFetchMock({
    [webfingerUrl]: () =>
      Response.json({
        subject: expectedSubject,
        links: [
          {
            rel: 'self',
            type: 'application/activity+json',
            href: actorUrl,
          },
        ],
      }),
    [actorUrl]: () =>
      Response.json({
        id: actorUrl,
        type: 'Service',
        preferredUsername: 'all',
      }),
  });

  await runRemoteDeploySmoke({
    env: 'staging',
    envVars: {
      MASTRA_SERVER_URL: 'https://mastra.test',
      SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
      ACTIVITYPUB_CANONICAL_ORIGIN: canonicalOrigin,
    },
    fetchImpl: fetch,
  });

  assert.equal(methods.includes('POST'), false);
});

test('remote deploy smoke maps fetch network errors to safe structured failures', async () => {
  const secretLikeMessage = 'connection failed for token=super-secret-smoke-value';
  const webfingerUrl = `${canonicalOrigin}/.well-known/webfinger?resource=${encodeURIComponent(expectedSubject)}`;
  const fetchMock: DeploySmokeFetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === webfingerUrl) {
      throw new Error(secretLikeMessage);
    }
    return new Response('not found', { status: 404 });
  };

  const result = await runRemoteDeploySmoke({
    env: 'staging',
    envVars: {
      MASTRA_SERVER_URL: 'https://mastra.test',
      SCHEDULER_SERVICE_ACCOUNT: 'scheduler@test.iam.gserviceaccount.com',
      ACTIVITYPUB_CANONICAL_ORIGIN: canonicalOrigin,
    },
    fetchImpl: fetchMock,
  });

  const serialized = JSON.stringify(result);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0]?.id, 'webfinger');
  assert.equal(result.checks[0]?.reason, 'network_error');
  assert.doesNotMatch(serialized, /super-secret-smoke-value/);
  assert.doesNotMatch(serialized, /connection failed/);
});
