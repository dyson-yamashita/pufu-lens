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
  assert.equal(contractFailure.checks[0]?.reason, 'subject_mismatch');
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
