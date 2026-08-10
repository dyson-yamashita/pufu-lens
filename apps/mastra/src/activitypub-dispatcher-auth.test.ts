import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActivityPubDispatcherAuthError,
  activityPubDispatcherAuthConfig,
  verifyActivityPubDispatcherSchedulerToken,
} from './activitypub-dispatcher-auth.ts';

const config = {
  ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE: 'https://mastra.example',
  ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT: 'scheduler-subject',
  SCHEDULER_SERVICE_ACCOUNT: 'scheduler@example.iam.gserviceaccount.com',
};

function createMockClient(payload: Record<string, unknown>) {
  return {
    verifyIdToken: async () => ({
      getPayload: () => payload,
    }),
  } as never;
}

test('activityPubDispatcherAuthConfig requires fixed scheduler auth env vars', () => {
  const config = activityPubDispatcherAuthConfig({
    ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE: 'https://mastra.example',
    ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT: 'scheduler-subject',
    SCHEDULER_SERVICE_ACCOUNT: 'scheduler@example.iam.gserviceaccount.com',
  });
  assert.equal(config.audience, 'https://mastra.example');
  assert.equal(config.schedulerSubject, 'scheduler-subject');
  assert.equal(config.schedulerServiceAccountEmail, 'scheduler@example.iam.gserviceaccount.com');
});

test('verifyActivityPubDispatcherSchedulerToken rejects missing bearer token', async () => {
  await assert.rejects(
    () =>
      verifyActivityPubDispatcherSchedulerToken({
        authorizationHeader: null,
        config: activityPubDispatcherAuthConfig({
          ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE: 'aud',
          ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT: 'sub',
          SCHEDULER_SERVICE_ACCOUNT: 'sa@example.com',
        }),
        client: {
          verifyIdToken: async () => {
            throw new Error('should not verify');
          },
        } as never,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ActivityPubDispatcherAuthError);
      assert.equal(error.statusCode, 401);
      return true;
    },
  );
});

test('verifyActivityPubDispatcherSchedulerToken normalizes email case', async () => {
  const identity = await verifyActivityPubDispatcherSchedulerToken({
    authorizationHeader: 'Bearer token',
    config: activityPubDispatcherAuthConfig({
      ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE: 'aud',
      ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT: 'sub',
      SCHEDULER_SERVICE_ACCOUNT: 'Scheduler@Example.COM',
    }),
    client: {
      verifyIdToken: async () => ({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          sub: 'sub',
          email: 'scheduler@example.com',
          email_verified: true,
          aud: 'aud',
        }),
      }),
    } as never,
  });
  assert.equal(identity.email, 'scheduler@example.com');
});

test('verifyActivityPubDispatcherSchedulerToken rejects invalid issuer', async () => {
  await assert.rejects(
    () =>
      verifyActivityPubDispatcherSchedulerToken({
        authorizationHeader: 'Bearer token',
        config: activityPubDispatcherAuthConfig(config),
        client: createMockClient({
          iss: 'https://evil.example',
          sub: config.ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT,
          email: config.SCHEDULER_SERVICE_ACCOUNT,
          email_verified: true,
          aud: config.ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE,
        }),
      }),
    (error: unknown) => error instanceof ActivityPubDispatcherAuthError && error.statusCode === 403,
  );
});

test('verifyActivityPubDispatcherSchedulerToken rejects invalid audience', async () => {
  await assert.rejects(
    () =>
      verifyActivityPubDispatcherSchedulerToken({
        authorizationHeader: 'Bearer token',
        config: activityPubDispatcherAuthConfig(config),
        client: createMockClient({
          iss: 'https://accounts.google.com',
          sub: config.ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT,
          email: config.SCHEDULER_SERVICE_ACCOUNT,
          email_verified: true,
          aud: 'wrong-audience',
        }),
      }),
    (error: unknown) =>
      error instanceof ActivityPubDispatcherAuthError && error.message === 'invalid token audience',
  );
});

test('verifyActivityPubDispatcherSchedulerToken rejects invalid subject', async () => {
  await assert.rejects(
    () =>
      verifyActivityPubDispatcherSchedulerToken({
        authorizationHeader: 'Bearer token',
        config: activityPubDispatcherAuthConfig(config),
        client: createMockClient({
          iss: 'https://accounts.google.com',
          sub: 'wrong-subject',
          email: config.SCHEDULER_SERVICE_ACCOUNT,
          email_verified: true,
          aud: config.ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE,
        }),
      }),
    (error: unknown) =>
      error instanceof ActivityPubDispatcherAuthError && error.message === 'invalid token subject',
  );
});

test('verifyActivityPubDispatcherSchedulerToken rejects invalid email', async () => {
  await assert.rejects(
    () =>
      verifyActivityPubDispatcherSchedulerToken({
        authorizationHeader: 'Bearer token',
        config: activityPubDispatcherAuthConfig(config),
        client: createMockClient({
          iss: 'https://accounts.google.com',
          sub: config.ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT,
          email: 'other@example.com',
          email_verified: true,
          aud: config.ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE,
        }),
      }),
    (error: unknown) =>
      error instanceof ActivityPubDispatcherAuthError && error.message === 'invalid token email',
  );
});

test('verifyActivityPubDispatcherSchedulerToken rejects unverified email', async () => {
  await assert.rejects(
    () =>
      verifyActivityPubDispatcherSchedulerToken({
        authorizationHeader: 'Bearer token',
        config: activityPubDispatcherAuthConfig(config),
        client: createMockClient({
          iss: 'https://accounts.google.com',
          sub: config.ACTIVITYPUB_DISPATCHER_SCHEDULER_SUBJECT,
          email: config.SCHEDULER_SERVICE_ACCOUNT,
          email_verified: false,
          aud: config.ACTIVITYPUB_DISPATCHER_OIDC_AUDIENCE,
        }),
      }),
    (error: unknown) =>
      error instanceof ActivityPubDispatcherAuthError && error.message === 'unverified token email',
  );
});
