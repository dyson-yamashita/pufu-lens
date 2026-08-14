import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoogleAuth } from 'google-auth-library';
import {
  type ActivityPubDispatcherTriggerDeps,
  triggerActivityPubInboxDispatcher,
} from './activitypub-dispatcher-trigger.ts';

const enabledEnv = {
  ACTIVITYPUB_INBOX_DISPATCHER_TRIGGER_ENABLED: '1',
  PUFU_LENS_GCP_PROJECT_ID: 'project-a',
  PUFU_LENS_CLOUD_RUN_JOBS_REGION: 'asia-east1',
  PUFU_LENS_ACTIVITYPUB_DISPATCHER_JOB_NAME: 'production-activitypub-dispatcher',
};

const fixedOverrideBody = JSON.stringify({
  overrides: {
    containerOverrides: [
      {
        env: [
          { name: 'WORKFLOW_ID', value: 'activitypub-dispatcher' },
          { name: 'WORKFLOW_INPUT_JSON', value: '{}' },
        ],
      },
    ],
  },
});

const expectedRunUrl =
  'https://run.googleapis.com/v2/projects/project-a/locations/asia-east1/jobs/production-activitypub-dispatcher:run';

function createDeps(
  overrides: Partial<ActivityPubDispatcherTriggerDeps> = {},
): ActivityPubDispatcherTriggerDeps {
  return {
    env: enabledEnv,
    createAuth: () => ({}) as GoogleAuth,
    getAccessToken: async () => 'test-access-token',
    fetcher: async () => new Response(null, { status: 200 }),
    ...overrides,
  };
}

for (const activityType of ['Follow', 'Accept', 'Undo'] as const) {
  test(`${activityType} inbox enqueue triggers one encoded Cloud Run Jobs run request`, async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    let tokenCalls = 0;
    const status = await triggerActivityPubInboxDispatcher(
      { activityType },
      createDeps({
        getAccessToken: async () => {
          tokenCalls += 1;
          return 'test-access-token';
        },
        fetcher: async (url, init) => {
          fetchCalls.push({ url: String(url), init });
          return new Response(null, { status: 200 });
        },
      }),
    );

    assert.equal(status, 'started');
    assert.equal(tokenCalls, 1);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, expectedRunUrl);
    assert.equal(fetchCalls[0]?.init?.method, 'POST');
    assert.equal(fetchCalls[0]?.init?.body, fixedOverrideBody);
    const headers = new Headers(fetchCalls[0]?.init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer test-access-token');
    assert.equal(headers.get('content-type'), 'application/json');
  });
}

test('disabled trigger flag skips without credential or fetch calls', async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const status = await triggerActivityPubInboxDispatcher(
    { activityType: 'Follow' },
    createDeps({
      env: { ...enabledEnv, ACTIVITYPUB_INBOX_DISPATCHER_TRIGGER_ENABLED: '0' },
      getAccessToken: async () => {
        tokenCalls += 1;
        return 'test-access-token';
      },
      fetcher: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 200 });
      },
    }),
  );

  assert.equal(status, 'skipped');
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

for (const activityType of ['Create', 'Announce', null] as const) {
  test(`${String(activityType)} inbox activity type skips without credential or fetch calls`, async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    const status = await triggerActivityPubInboxDispatcher(
      { activityType },
      createDeps({
        getAccessToken: async () => {
          tokenCalls += 1;
          return 'test-access-token';
        },
        fetcher: async () => {
          fetchCalls += 1;
          return new Response(null, { status: 200 });
        },
      }),
    );

    assert.equal(status, 'skipped');
    assert.equal(tokenCalls, 0);
    assert.equal(fetchCalls, 0);
  });
}

test('missing dispatcher config resolves as fallback without throwing', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const status = await triggerActivityPubInboxDispatcher(
    { activityType: 'Follow' },
    createDeps({
      env: {
        ACTIVITYPUB_INBOX_DISPATCHER_TRIGGER_ENABLED: '1',
        PUFU_LENS_GCP_PROJECT_ID: '',
        PUFU_LENS_CLOUD_RUN_JOBS_REGION: 'asia-east1',
        PUFU_LENS_ACTIVITYPUB_DISPATCHER_JOB_NAME: 'production-activitypub-dispatcher',
      },
      logger: (payload) => {
        logs.push(payload);
      },
    }),
  );

  assert.equal(status, 'fallback');
  assert.deepEqual(logs, [
    {
      event: 'activitypub_inbox_dispatcher_trigger',
      status: 'fallback',
      errorCode: 'missing_config',
    },
  ]);
});

test('credential rejection resolves as fallback without logging secrets or error messages', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const status = await triggerActivityPubInboxDispatcher(
    { activityType: 'Follow' },
    createDeps({
      getAccessToken: async () => {
        throw new Error('super-secret credential failure');
      },
      logger: (payload) => {
        logs.push(payload);
      },
    }),
  );

  assert.equal(status, 'fallback');
  assert.deepEqual(logs, [
    {
      event: 'activitypub_inbox_dispatcher_trigger',
      status: 'fallback',
      errorCode: 'network_error',
    },
  ]);
  assert.equal(JSON.stringify(logs).includes('super-secret'), false);
});

test('token timeout resolves as fallback without throwing', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const status = await triggerActivityPubInboxDispatcher(
    { activityType: 'Follow' },
    createDeps({
      getAccessToken: async () => {
        throw new Error('cloud access token timed out');
      },
      logger: (payload) => {
        logs.push(payload);
      },
    }),
  );

  assert.equal(status, 'fallback');
  assert.deepEqual(logs, [
    {
      event: 'activitypub_inbox_dispatcher_trigger',
      status: 'fallback',
      errorCode: 'token_timeout',
    },
  ]);
});

test('network rejection resolves as fallback without logging error messages', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const status = await triggerActivityPubInboxDispatcher(
    { activityType: 'Follow' },
    createDeps({
      fetcher: async () => {
        throw new Error('sensitive network detail');
      },
      logger: (payload) => {
        logs.push(payload);
      },
    }),
  );

  assert.equal(status, 'fallback');
  assert.deepEqual(logs, [
    {
      event: 'activitypub_inbox_dispatcher_trigger',
      status: 'fallback',
      errorCode: 'network_error',
    },
  ]);
  assert.equal(JSON.stringify(logs).includes('sensitive network detail'), false);
});

test('non-2xx Cloud Run Jobs response resolves as fallback without logging response body', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const status = await triggerActivityPubInboxDispatcher(
    { activityType: 'Follow' },
    createDeps({
      fetcher: async () =>
        new Response('sensitive response body', {
          status: 503,
        }),
      logger: (payload) => {
        logs.push(payload);
      },
    }),
  );

  assert.equal(status, 'fallback');
  assert.deepEqual(logs, [
    {
      event: 'activitypub_inbox_dispatcher_trigger',
      status: 'fallback',
      errorCode: 'http_error',
    },
  ]);
  assert.equal(JSON.stringify(logs).includes('sensitive response body'), false);
});

test('fetch timeout resolves as fallback without throwing', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const status = await triggerActivityPubInboxDispatcher(
    { activityType: 'Follow' },
    createDeps({
      fetcher: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
      logger: (payload) => {
        logs.push(payload);
      },
    }),
  );

  assert.equal(status, 'fallback');
  assert.deepEqual(logs, [
    {
      event: 'activitypub_inbox_dispatcher_trigger',
      status: 'fallback',
      errorCode: 'fetch_timeout',
    },
  ]);
});
