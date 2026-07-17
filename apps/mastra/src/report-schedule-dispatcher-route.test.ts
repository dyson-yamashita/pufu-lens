import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatcherJobRunUrl,
  getCloudAccessTokenWithTimeout,
  parseDispatcherRequest,
  safeDispatcherRouteError,
  startDispatcherJob,
} from './report-schedule-dispatcher-route.ts';

const config = {
  jobName: 'staging-report-schedule-dispatcher',
  projectId: 'project-a',
  region: 'asia-east1',
};

test('report schedule dispatcher request accepts only an empty JSON object', () => {
  assert.deepEqual(parseDispatcherRequest({}), {});
  assert.throws(() => parseDispatcherRequest({ project: 'other' }), /empty JSON object/);
  assert.throws(() => parseDispatcherRequest([]), /empty JSON object/);
});

test('report schedule dispatcher route errors never expose provider response bodies or tokens', () => {
  assert.equal(
    safeDispatcherRouteError(new Error('Cloud Run Jobs API returned HTTP 403: token=secret')),
    'Cloud Run Jobs API HTTP 403',
  );
  assert.equal(
    safeDispatcherRouteError(new Error('oauth_token=secret raw provider response')),
    'dispatcher job start failed',
  );
});

test('report schedule dispatcher Cloud Run Job URL encodes resource identifiers', () => {
  assert.equal(
    dispatcherJobRunUrl(config),
    'https://run.googleapis.com/v2/projects/project-a/locations/asia-east1/jobs/staging-report-schedule-dispatcher:run',
  );
});

test('report schedule dispatcher job start sends no workflow secrets or project input', async () => {
  let requestBody = '';
  const execution = await startDispatcherJob(config, 'access-token', async (_url, init) => {
    requestBody = String(init?.body);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer access-token');
    return new Response(JSON.stringify({ name: 'operations/execution-a' }), { status: 200 });
  });
  assert.deepEqual(JSON.parse(requestBody), {
    overrides: {
      containerOverrides: [{ env: [{ name: 'WORKFLOW_INPUT_JSON', value: '{}' }] }],
    },
  });
  assert.equal(execution, 'operations/execution-a');
});

test('report schedule dispatcher job start passes an abort signal with a fetch timeout', async () => {
  let receivedSignal: AbortSignal | undefined;
  await startDispatcherJob(config, 'access-token', async (_url, init) => {
    receivedSignal = init?.signal ?? undefined;
    return new Response(JSON.stringify({ name: 'operations/execution-a' }), { status: 200 });
  });
  assert.ok(receivedSignal);
  assert.equal(receivedSignal?.aborted, false);
});

test('report schedule dispatcher route maps external call timeouts to safe errors', () => {
  assert.equal(
    safeDispatcherRouteError(new Error('cloud access token timed out')),
    'dispatcher job start failed',
  );
  assert.equal(safeDispatcherRouteError(new Error('fetch aborted')), 'dispatcher job start failed');
});

test('getCloudAccessTokenWithTimeout returns a token when GoogleAuth responds in time', async () => {
  const auth = {
    async getAccessToken() {
      return 'token-a';
    },
  };
  assert.equal(await getCloudAccessTokenWithTimeout(auth as never), 'token-a');
});

test('getCloudAccessTokenWithTimeout rejects a slow token fetch', async () => {
  let rejectToken: ((error: Error) => void) | undefined;
  const tokenPromise = new Promise<string>((_resolve, reject) => {
    rejectToken = reject;
  });
  const auth = {
    getAccessToken() {
      return tokenPromise;
    },
  };
  await assert.rejects(
    () => getCloudAccessTokenWithTimeout(auth as never, 50),
    /cloud access token timed out/,
  );
  rejectToken?.(new Error('token fetch cleanup'));
  await tokenPromise.catch(() => undefined);
});

test('startDispatcherJob rejects when fetch ignores the abort signal until timeout', async () => {
  let receivedSignal: AbortSignal | undefined;
  let rejectFetch: ((error: Error) => void) | undefined;
  const fetchPromise = new Promise<Response>((_resolve, reject) => {
    rejectFetch = reject;
  });
  await assert.rejects(
    () =>
      startDispatcherJob(
        config,
        'access-token',
        (_url, init) => {
          receivedSignal = init?.signal ?? undefined;
          return fetchPromise;
        },
        { timeoutMs: 50 },
      ),
    /dispatcher job fetch timed out/,
  );
  assert.equal(receivedSignal?.aborted, true);
  rejectFetch?.(new Error('fetch cleanup'));
  await fetchPromise.catch(() => undefined);
});
