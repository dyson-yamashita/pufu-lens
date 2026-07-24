import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleSyntheticMonitorObservationsRequest,
  SYNTHETIC_MONITOR_MAX_BODY_BYTES,
  safeSyntheticMonitorRouteError,
} from '@pufu-lens/web/synthetic-monitor';

const monitorEnv = {
  SYNTHETIC_MONITOR_OIDC_AUDIENCE: 'https://mastra.example.internal',
  SYNTHETIC_MONITOR_SERVICE_ACCOUNTS: 'monitor@example.iam.gserviceaccount.com',
  SYNTHETIC_MONITOR_PROJECT_SLUGS: 'sample-a',
  DATABASE_URL: 'postgresql://example',
};

const authClient = {
  verifyIdToken: async () => ({
    getPayload: () => ({
      email: 'monitor@example.iam.gserviceaccount.com',
      email_verified: true,
    }),
  }),
} as never;

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(text, 'utf8'));
      controller.close();
    },
  });
}

test('safeSyntheticMonitorRouteError never exposes tokens or provider payloads', () => {
  assert.equal(
    safeSyntheticMonitorRouteError(new Error('oauth_token=secret provider response body')),
    'synthetic monitor request failed',
  );
  assert.equal(
    safeSyntheticMonitorRouteError(new Error('monitor authentication failed')),
    'monitor authentication failed',
  );
});

test('handleSyntheticMonitorObservationsRequest authenticates before parsing the body', async () => {
  const invalidJson = await handleSyntheticMonitorObservationsRequest({
    authorizationHeader: null,
    body: streamFromText('{bad json'),
    contentLengthHeader: null,
    env: {
      SYNTHETIC_MONITOR_OIDC_AUDIENCE: 'https://mastra.example.internal',
      SYNTHETIC_MONITOR_SERVICE_ACCOUNTS: 'monitor@example.iam.gserviceaccount.com',
      SYNTHETIC_MONITOR_PROJECT_SLUGS: 'sample-a',
      DATABASE_URL: 'postgresql://example',
    },
  });
  assert.equal(invalidJson.status, 401);
  assert.equal(
    'error' in invalidJson.body ? invalidJson.body.error : '',
    'monitor authentication is required',
  );

  const invalidBearer = await handleSyntheticMonitorObservationsRequest({
    authorizationHeader: 'Bearer secret-token',
    body: streamFromText(
      '{"projectSlug":"sample-a","sources":[{"kind":"gmail","threadId":"t","expectedMessageId":"m"}]}',
    ),
    contentLengthHeader: null,
    env: {
      SYNTHETIC_MONITOR_OIDC_AUDIENCE: 'https://mastra.example.internal',
      SYNTHETIC_MONITOR_SERVICE_ACCOUNTS: 'monitor@example.iam.gserviceaccount.com',
      SYNTHETIC_MONITOR_PROJECT_SLUGS: 'sample-a',
      DATABASE_URL: 'postgresql://example',
    },
    authClient: {
      verifyIdToken: async () => {
        throw new Error('invalid token secret-token');
      },
    } as never,
  });
  assert.equal(invalidBearer.status, 401);
  assert.equal(
    'error' in invalidBearer.body ? invalidBearer.body.error : '',
    'monitor authentication failed',
  );
  assert.equal(JSON.stringify(invalidBearer.body).includes('secret-token'), false);

  const invalidJsonAfterAuth = await handleSyntheticMonitorObservationsRequest({
    authorizationHeader: 'Bearer valid-token',
    body: streamFromText('{bad json'),
    contentLengthHeader: null,
    env: {
      SYNTHETIC_MONITOR_OIDC_AUDIENCE: 'https://mastra.example.internal',
      SYNTHETIC_MONITOR_SERVICE_ACCOUNTS: 'monitor@example.iam.gserviceaccount.com',
      SYNTHETIC_MONITOR_PROJECT_SLUGS: 'sample-a',
      DATABASE_URL: 'postgresql://example',
    },
    authClient: {
      verifyIdToken: async () => ({
        getPayload: () => ({
          email: 'monitor@example.iam.gserviceaccount.com',
          email_verified: true,
        }),
      }),
    } as never,
    createSql: () =>
      ({
        end: async () => undefined,
      }) as never,
    createStorage: () =>
      ({
        exists: async () => false,
        get: async () => ({}) as NodeJS.ReadableStream,
        getText: async () => '',
        put: async () => ({ uri: '' }),
        list: async function* () {},
      }) as never,
  });
  assert.equal(invalidJsonAfterAuth.status, 400);
  assert.equal(
    'error' in invalidJsonAfterAuth.body ? invalidJsonAfterAuth.body.error : '',
    'request body must be valid JSON.',
  );
});

test('handleSyntheticMonitorObservationsRequest returns 403 for project scope violations after auth', async () => {
  const response = await handleSyntheticMonitorObservationsRequest({
    authorizationHeader: 'Bearer valid-token',
    body: streamFromText(
      '{"projectSlug":"other-project","sources":[{"kind":"gmail","threadId":"t","expectedMessageId":"m"}]}',
    ),
    contentLengthHeader: null,
    env: monitorEnv,
    authClient,
  });
  assert.equal(response.status, 403);
  assert.equal('error' in response.body ? response.body.error : '', 'monitor project scope denied');
});

test('handleSyntheticMonitorObservationsRequest returns 401 for allowlisted-audience but unlisted service accounts', async () => {
  const response = await handleSyntheticMonitorObservationsRequest({
    authorizationHeader: 'Bearer valid-token',
    body: streamFromText(
      '{"projectSlug":"sample-a","sources":[{"kind":"gmail","threadId":"t","expectedMessageId":"m"}]}',
    ),
    contentLengthHeader: null,
    env: monitorEnv,
    authClient: {
      verifyIdToken: async () => ({
        getPayload: () => ({
          email: 'other@example.iam.gserviceaccount.com',
          email_verified: true,
        }),
      }),
    } as never,
  });
  assert.equal(response.status, 401);
  assert.equal(
    'error' in response.body ? response.body.error : '',
    'monitor authentication failed',
  );
  assert.equal(
    JSON.stringify(response.body).includes('other@example.iam.gserviceaccount.com'),
    false,
  );
});

test('handleSyntheticMonitorObservationsRequest rejects oversized Content-Length after auth', async () => {
  const response = await handleSyntheticMonitorObservationsRequest({
    authorizationHeader: 'Bearer valid-token',
    body: streamFromText('{}'),
    contentLengthHeader: String(SYNTHETIC_MONITOR_MAX_BODY_BYTES + 1),
    env: monitorEnv,
    authClient,
  });
  assert.equal(response.status, 400);
  assert.equal(
    'error' in response.body ? response.body.error : '',
    'request body exceeds 64KiB limit.',
  );
});

test('toSyntheticMonitorRouteResult logs only safe summaries for internal failures', async () => {
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (message?: unknown) => {
    logs.push(String(message));
  };
  try {
    const { toSyntheticMonitorRouteResult } = await import('@pufu-lens/web/synthetic-monitor');
    const result = toSyntheticMonitorRouteResult(new Error('database password=secret thread-1'));
    assert.equal(result.status, 503);
    assert.equal(
      'error' in result.body ? result.body.error : '',
      'synthetic monitor request failed',
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.includes('secret'), false);
    assert.equal(logs[0]?.includes('thread-1'), false);
  } finally {
    console.error = originalError;
  }
});
