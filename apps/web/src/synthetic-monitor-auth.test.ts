import assert from 'node:assert/strict';
import test from 'node:test';
import { verifySyntheticMonitorBearerToken } from './synthetic-monitor-auth.ts';
import { safeSyntheticMonitorRouteError } from './synthetic-monitor-contract.ts';

const auth = {
  audience: 'https://mastra.example.internal',
  allowedServiceAccounts: ['monitor@example.iam.gserviceaccount.com'],
};

test('verifySyntheticMonitorBearerToken accepts allowlisted verified service accounts', async () => {
  const principal = await verifySyntheticMonitorBearerToken({
    auth,
    bearerToken: 'token',
    client: {
      verifyIdToken: async () => ({
        getPayload: () => ({
          email: 'monitor@example.iam.gserviceaccount.com',
          email_verified: true,
        }),
      }),
    } as never,
  });
  assert.equal(principal.email, 'monitor@example.iam.gserviceaccount.com');
});

test('verifySyntheticMonitorBearerToken rejects unverified, unlisted, and invalid tokens safely', async () => {
  await assert.rejects(
    () =>
      verifySyntheticMonitorBearerToken({
        auth,
        bearerToken: 'token',
        client: {
          verifyIdToken: async () => ({
            getPayload: () => ({
              email: 'monitor@example.iam.gserviceaccount.com',
              email_verified: false,
            }),
          }),
        } as never,
      }),
    /monitor authentication failed/,
  );
  await assert.rejects(
    () =>
      verifySyntheticMonitorBearerToken({
        auth,
        bearerToken: 'token',
        client: {
          verifyIdToken: async () => ({
            getPayload: () => ({
              email: 'other@example.iam.gserviceaccount.com',
              email_verified: true,
            }),
          }),
        } as never,
      }),
    /monitor authentication failed/,
  );
  await assert.rejects(
    () =>
      verifySyntheticMonitorBearerToken({
        auth,
        bearerToken: 'secret-token-value',
        client: {
          verifyIdToken: async () => {
            throw new Error('invalid token secret-token-value');
          },
        } as never,
      }),
    /monitor authentication failed/,
  );
  assert.equal(
    safeSyntheticMonitorRouteError(new Error('invalid token secret-token-value')),
    'synthetic monitor request failed',
  );
  assert.equal(
    safeSyntheticMonitorRouteError(new Error('monitor@example.iam.gserviceaccount.com denied')),
    'synthetic monitor request failed',
  );
});
