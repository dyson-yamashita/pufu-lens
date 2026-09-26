import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localStaging } from '../local-staging.mjs';
import { metadataReady, remoteTransport, runRemoteFixture } from '../remote-fixture.mjs';

test('metadata preflight accepts the observed API type spelling without relaxing required fields', () => {
  for (const indexType of ['string', 'String'])
    assert.equal(
      metadataReady({
        metadataIndexes: ['projectId', 'model'].map((propertyName) => ({
          propertyName,
          indexType,
        })),
      }),
      true,
    );
  for (const result of [
    null,
    {},
    { metadataIndexes: [] },
    { metadataIndexes: [{ propertyName: 'projectId', indexType: 'String' }] },
    {
      metadataIndexes: ['projectId', 'model'].map((propertyName) => ({
        propertyName,
        indexType: 'number',
      })),
    },
  ])
    assert.equal(metadataReady(result), false);
});

test('remote lifecycle runs through real local D1 and workerd, aggregating actual D1 metadata', async () => {
  const local = await localStaging();
  try {
    const report = await runRemoteFixture(
      (operation, input) => {
        const { unauthorized, ...control } = input;
        return local.call(operation, control, unauthorized ? 'invalid' : undefined);
      },
      { sleep: async () => {} },
    );
    assert.equal(report.outcome, 'passed', JSON.stringify(report));
    assert.equal(report.stages.length, 2);
    assert.ok(report.rowsRead > 0);
    assert.ok(report.rowsWritten > 0);
    assert.ok(report.databaseBytes > 0 && report.databaseBytes < 5_000_000);
    assert.equal(report.upsertedVectors, 24);
    assert.ok(report.requests < 100);
  } finally {
    await local.runtime.dispose();
  }
});

test('unknown usage, HTTP faults and oversized accounting stop before another mutation', async () => {
  for (const reply of [
    { status: 200, body: {} },
    { status: 429, body: {} },
    { status: 200, body: { usage: { complete: false } } },
    {
      status: 200,
      body: {
        usage: {
          complete: true,
          rowsRead: 100_001,
          rowsWritten: 0,
          databaseBytes: 0,
          queries: 0,
          upsertedVectors: 0,
        },
      },
    },
  ]) {
    let calls = 0;
    const result = await runRemoteFixture(
      async () => {
        calls++;
        if (calls <= 2) return { status: calls === 1 ? 401 : 400, body: {} };
        return reply;
      },
      { sleep: async () => {} },
    );
    assert.equal(result.outcome, 'failed');
    assert.equal(calls, 3);
  }
});

test('permanent empty semantic visibility fails instead of promoting submission to success', async () => {
  const local = await localStaging();
  try {
    local.state.override = [];
    const result = await runRemoteFixture(
      (operation, input) => {
        const { unauthorized, ...control } = input;
        return local.call(operation, control, unauthorized ? 'invalid' : undefined);
      },
      { sleep: async () => {} },
    );
    assert.equal(result.outcome, 'failed');
    assert.equal(result.failure, 'visibility_timeout');
    assert.equal(result.queries, 20);
  } finally {
    await local.runtime.dispose();
  }
});

test('remote transport rejects unrelated origins before reading a token', async () => {
  for (const origin of [
    'http://pufu-6e-composition-check.example.workers.dev',
    'https://other.example.workers.dev',
    'https://pufu-6e-composition-check.example.workers.dev/?token=bad',
  ])
    await assert.rejects(
      () => remoteTransport(origin, '/missing'),
      /Invalid dedicated staging origin/,
    );
});

test('expected stale-vector 503 still requires usage accounting', async () => {
  const local = await localStaging();
  let missingUsage = false;
  try {
    const report = await runRemoteFixture(
      async (operation, input) => {
        assert.equal(missingUsage, false, 'must stop before the next operation');
        const { unauthorized, ...control } = input;
        const response = await local.call(operation, control, unauthorized ? 'invalid' : undefined);
        if (response.status === 503) {
          missingUsage = true;
          delete response.body.usage;
        }
        return response;
      },
      { sleep: async () => {} },
    );
    assert.equal(missingUsage, true);
    assert.equal(report.outcome, 'failed');
    assert.equal(report.failure, 'transport_or_budget_or_usage');
  } finally {
    await local.runtime.dispose();
  }
});
