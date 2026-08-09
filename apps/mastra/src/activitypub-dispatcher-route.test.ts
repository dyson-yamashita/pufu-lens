import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActivityPubDispatcherAuthError,
  activityPubDispatcherAuthConfig,
  verifyActivityPubDispatcherSchedulerToken,
} from './activitypub-dispatcher-auth.ts';
import {
  ActivityPubDispatcherRequestError,
  handleActivityPubDispatcherHttpRequest,
  handleActivityPubDispatcherRequest,
  hasActiveDispatcherExecution,
  parseActivityPubDispatcherJsonBody,
  parseActivityPubDispatcherRequest,
} from './activitypub-dispatcher-route.ts';

const env = {
  ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE: 'https://mastra.example',
  ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT: 'scheduler-subject',
  SCHEDULER_SERVICE_ACCOUNT: 'scheduler@example.iam.gserviceaccount.com',
  ACTIVITYPUB_DISPATCHER_JOB_NAME: 'staging-activitypub-dispatcher',
  GOOGLE_CLOUD_PROJECT: 'project-a',
  CLOUD_RUN_JOBS_REGION: 'asia-east1',
};

test('parseActivityPubDispatcherRequest accepts only an empty JSON object', () => {
  assert.deepEqual(parseActivityPubDispatcherRequest({}), {});
  assert.throws(
    () => parseActivityPubDispatcherRequest({ project: 'other' }),
    ActivityPubDispatcherRequestError,
  );
  assert.throws(() => parseActivityPubDispatcherRequest([]), ActivityPubDispatcherRequestError);
});

test('activityPubDispatcherAuthConfig uses SCHEDULER_SERVICE_ACCOUNT email allowlist', () => {
  const config = activityPubDispatcherAuthConfig(env);
  assert.equal(config.schedulerServiceAccountEmail, env.SCHEDULER_SERVICE_ACCOUNT);
});

test('verifyActivityPubDispatcherSchedulerToken rejects wrong audience and unverified email', async () => {
  await assert.rejects(
    () =>
      verifyActivityPubDispatcherSchedulerToken({
        authorizationHeader: 'Bearer token',
        config: activityPubDispatcherAuthConfig(env),
        client: {
          verifyIdToken: async () => ({
            getPayload: () => ({
              iss: 'https://accounts.google.com',
              sub: 'scheduler-subject',
              email: 'scheduler@example.iam.gserviceaccount.com',
              email_verified: false,
              aud: 'wrong-audience',
            }),
          }),
        } as never,
      }),
    (error: unknown) => error instanceof ActivityPubDispatcherAuthError,
  );
});

test('parseActivityPubDispatcherJsonBody rejects malformed JSON', () => {
  assert.throws(
    () => parseActivityPubDispatcherJsonBody('{not-json'),
    ActivityPubDispatcherRequestError,
  );
});

test('handleActivityPubDispatcherRequest returns 400 for non-empty JSON bodies', async () => {
  const result = await handleActivityPubDispatcherRequest({ unexpected: true }, 'Bearer token', {
    env,
    fetcher: async () => new Response('{}', { status: 200 }),
    getAccessToken: async () => 'token',
    createAuth: () => ({}) as never,
    verifyToken: async () => ({
      subject: 'scheduler-subject',
      email: env.SCHEDULER_SERVICE_ACCOUNT,
    }),
  });
  assert.equal(result.status, 400);
});

test('handleActivityPubDispatcherHttpRequest returns 400 for malformed raw JSON without verifying token', async () => {
  let verifyCalled = false;
  const result = await handleActivityPubDispatcherHttpRequest('{not-json', 'Bearer token', {
    env,
    fetcher: async () => new Response('{}', { status: 200 }),
    getAccessToken: async () => 'token',
    createAuth: () => ({}) as never,
    verifyToken: async () => {
      verifyCalled = true;
      return {
        subject: 'scheduler-subject',
        email: env.SCHEDULER_SERVICE_ACCOUNT,
      };
    },
  });
  assert.equal(result.status, 400);
  assert.equal(verifyCalled, false);
});

test('handleActivityPubDispatcherHttpRequest treats an empty body as an empty JSON object', async () => {
  let verifyCalled = false;
  const result = await handleActivityPubDispatcherHttpRequest('   ', 'Bearer token', {
    env,
    fetcher: async (url) => {
      if (String(url).includes('/executions')) {
        return new Response(JSON.stringify({ executions: [{ runningCount: 1 }] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    },
    getAccessToken: async () => 'token',
    createAuth: () => ({}) as never,
    verifyToken: async () => {
      verifyCalled = true;
      return {
        subject: 'scheduler-subject',
        email: env.SCHEDULER_SERVICE_ACCOUNT,
      };
    },
  });
  assert.equal(result.status, 202);
  assert.equal(verifyCalled, true);
});

test('handleActivityPubDispatcherRequest no-ops when an active execution exists', async () => {
  let runCalled = false;
  const result = await handleActivityPubDispatcherRequest({}, 'Bearer token', {
    env,
    fetcher: async (url) => {
      if (String(url).includes('/executions')) {
        return new Response(JSON.stringify({ executions: [{ runningCount: 1 }] }), { status: 200 });
      }
      runCalled = true;
      return new Response('{}', { status: 200 });
    },
    getAccessToken: async () => 'token',
    createAuth: () => ({}) as never,
    verifyToken: async () => ({
      subject: 'scheduler-subject',
      email: env.SCHEDULER_SERVICE_ACCOUNT,
    }),
  });
  assert.equal(result.status, 202);
  assert.equal((result.body as { noOp?: boolean }).noOp, true);
  assert.equal(runCalled, false);
});

test('hasActiveDispatcherExecution treats missing completionTime as active', async () => {
  const active = await hasActiveDispatcherExecution(
    { jobName: 'job', projectId: 'project-a', region: 'asia-east1' },
    'token',
    async () =>
      new Response(JSON.stringify({ executions: [{ name: 'operations/exec-1' }] }), {
        status: 200,
      }),
  );
  assert.equal(active, true);
});
