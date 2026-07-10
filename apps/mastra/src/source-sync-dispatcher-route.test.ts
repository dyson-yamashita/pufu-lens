import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dispatcherJobRunUrl,
  parseDispatcherRequest,
  safeDispatcherRouteError,
  startDispatcherJob,
} from './source-sync-dispatcher-route.ts';

const config = {
  jobName: 'staging-source-sync-dispatcher',
  projectId: 'project-a',
  region: 'asia-east1',
};

test('dispatcher request accepts only an empty JSON object', () => {
  assert.deepEqual(parseDispatcherRequest({}), {});
  assert.throws(() => parseDispatcherRequest({ project: 'other' }), /empty JSON object/);
  assert.throws(() => parseDispatcherRequest([]), /empty JSON object/);
});

test('dispatcher route errors never expose provider response bodies or tokens', () => {
  assert.equal(
    safeDispatcherRouteError(new Error('Cloud Run Jobs API returned HTTP 403: token=secret')),
    'Cloud Run Jobs API HTTP 403',
  );
  assert.equal(
    safeDispatcherRouteError(new Error('oauth_token=secret raw provider response')),
    'dispatcher job start failed',
  );
});

test('dispatcher Cloud Run Job URL encodes resource identifiers', () => {
  assert.equal(
    dispatcherJobRunUrl(config),
    'https://run.googleapis.com/v2/projects/project-a/locations/asia-east1/jobs/staging-source-sync-dispatcher:run',
  );
});

test('dispatcher job start sends no workflow secrets or source input', async () => {
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
