import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateScheduleStageObservation } from './synthetic-monitor-schedule.ts';

const now = Date.parse('2026-07-20T12:00:00.000Z');

test('aggregateScheduleStageObservation uses any enabled, max retryCount, and any active lease', () => {
  assert.deepEqual(aggregateScheduleStageObservation([], now), {
    status: 'not_found',
    enabled: false,
    retryCount: 0,
    nextRunDue: false,
  });
  assert.deepEqual(
    aggregateScheduleStageObservation(
      [
        { enabled: false, retryCount: 2, leaseExpiresAt: null, nextRunAt: null },
        { enabled: false, retryCount: 1, leaseExpiresAt: null, nextRunAt: null },
      ],
      now,
    ),
    { status: 'ok', enabled: false, retryCount: 2, nextRunDue: false },
  );
  assert.deepEqual(
    aggregateScheduleStageObservation(
      [
        { enabled: true, retryCount: 0, leaseExpiresAt: null, nextRunAt: null },
        { enabled: true, retryCount: 3, leaseExpiresAt: null, nextRunAt: null },
      ],
      now,
    ),
    { status: 'failed', enabled: true, retryCount: 3, nextRunDue: false },
  );
  assert.deepEqual(
    aggregateScheduleStageObservation(
      [
        {
          enabled: true,
          retryCount: 0,
          leaseExpiresAt: '2026-07-20T13:00:00.000Z',
          nextRunAt: '2026-07-20T11:00:00.000Z',
        },
        { enabled: true, retryCount: 0, leaseExpiresAt: null, nextRunAt: null },
      ],
      now,
    ),
    { status: 'pending', enabled: true, retryCount: 0, nextRunDue: true },
  );
});

test('aggregateScheduleStageObservation marks due enabled schedules as pending with nextRunDue', () => {
  assert.deepEqual(
    aggregateScheduleStageObservation(
      [
        {
          enabled: true,
          retryCount: 0,
          leaseExpiresAt: null,
          nextRunAt: '2026-07-20T12:00:00.000Z',
        },
      ],
      now,
    ),
    { status: 'pending', enabled: true, retryCount: 0, nextRunDue: true },
  );
  assert.deepEqual(
    aggregateScheduleStageObservation(
      [
        {
          enabled: true,
          retryCount: 0,
          leaseExpiresAt: null,
          nextRunAt: '2099-01-01T01:00:00.000Z',
        },
      ],
      now,
    ),
    { status: 'ok', enabled: true, retryCount: 0, nextRunDue: false },
  );
});

test('aggregateScheduleStageObservation prefers failed over active lease when retryCount is positive', () => {
  assert.deepEqual(
    aggregateScheduleStageObservation(
      [
        {
          enabled: true,
          retryCount: 2,
          leaseExpiresAt: '2026-07-20T13:00:00.000Z',
          nextRunAt: '2026-07-20T11:00:00.000Z',
        },
      ],
      now,
    ),
    { status: 'failed', enabled: true, retryCount: 2, nextRunDue: true },
  );
});
