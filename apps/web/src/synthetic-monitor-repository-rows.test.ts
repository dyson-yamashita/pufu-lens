import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSyntheticMonitorChunkCountRow,
  parseSyntheticMonitorPeriodRunRow,
  parseSyntheticMonitorProjectRow,
  parseSyntheticMonitorReportScheduleRow,
  parseSyntheticMonitorScheduleRows,
} from './synthetic-monitor-repository-rows.ts';

test('parseSyntheticMonitorProjectRow validates UUID, slug, and graph name', () => {
  const project = parseSyntheticMonitorProjectRow([
    {
      id: '11111111-1111-4111-8111-111111111111',
      slug: 'sample-a',
      graphName: 'graph_sample_a',
    },
  ]);
  assert.equal(project?.slug, 'sample-a');
  const nilUuidProject = parseSyntheticMonitorProjectRow([
    {
      id: '00000000-0000-0000-0000-000000000101',
      slug: 'local-dev',
      graphName: 'graph_local_dev',
    },
  ]);
  assert.equal(nilUuidProject?.id, '00000000-0000-0000-0000-000000000101');
  assert.throws(
    () =>
      parseSyntheticMonitorProjectRow([
        { id: 'not-a-uuid', slug: 'sample-a', graphName: 'graph_sample_a' },
      ]),
    /expected UUID string/,
  );
});

test('parseSyntheticMonitorChunkCountRow validates non-negative integers', () => {
  assert.deepEqual(parseSyntheticMonitorChunkCountRow([{ total: 2, withEmbedding: 1 }]), {
    total: 2,
    withEmbedding: 1,
  });
  assert.throws(
    () => parseSyntheticMonitorChunkCountRow([{ total: 1, withEmbedding: 2 }]),
    /withEmbedding exceeds total/,
  );
});

test('parseSyntheticMonitorScheduleRows validates booleans, timestamps, and nextRunAt', () => {
  assert.deepEqual(
    parseSyntheticMonitorScheduleRows([
      {
        enabled: true,
        retryCount: 0,
        leaseExpiresAt: '2026-07-20T01:00:00.000Z',
        nextRunAt: '2099-01-01T01:00:00.000Z',
      },
    ]),
    [
      {
        enabled: true,
        retryCount: 0,
        leaseExpiresAt: '2026-07-20T01:00:00.000Z',
        nextRunAt: '2099-01-01T01:00:00.000Z',
      },
    ],
  );
  assert.throws(
    () =>
      parseSyntheticMonitorScheduleRows([
        { enabled: 'yes', retryCount: 0, leaseExpiresAt: null, nextRunAt: null },
      ]),
    /expected boolean/,
  );
});

test('parseSyntheticMonitorReportScheduleRow and parseSyntheticMonitorPeriodRunRow validate enums', () => {
  assert.deepEqual(
    parseSyntheticMonitorReportScheduleRow([{ frequency: 'weekly', nextRunAt: null }]),
    {
      frequency: 'weekly',
      nextRunAt: null,
    },
  );
  assert.throws(
    () => parseSyntheticMonitorReportScheduleRow([{ frequency: 'daily', nextRunAt: null }]),
    /report schedule frequency/,
  );
  assert.deepEqual(parseSyntheticMonitorPeriodRunRow([{ status: 'succeeded', reportId: null }]), {
    status: 'succeeded',
    reportId: null,
  });
  assert.throws(
    () => parseSyntheticMonitorPeriodRunRow([{ status: 'broken', reportId: null }]),
    /period run status/,
  );
});
