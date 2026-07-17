import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enumerateDueMaterializePeriods,
  parseDueMaterializeScheduleRow,
} from './report-schedule-materialize.ts';

test('parseDueMaterializeScheduleRow validates claimed schedule lease fields', () => {
  assert.deepEqual(
    parseDueMaterializeScheduleRow({
      claimedAt: '2026-07-20T01:00:00.000Z',
      frequency: 'weekly',
      nextRunAt: '2026-07-06T01:00:00.000Z',
      projectId: 'project-a',
      scheduleId: 'schedule-a',
      workerToken: 'worker-a',
    }),
    {
      claimedAt: '2026-07-20T01:00:00.000Z',
      frequency: 'weekly',
      nextRunAt: '2026-07-06T01:00:00.000Z',
      projectId: 'project-a',
      scheduleId: 'schedule-a',
      workerToken: 'worker-a',
    },
  );
  assert.equal(parseDueMaterializeScheduleRow(null), null);
  assert.throws(() => parseDueMaterializeScheduleRow({}), /frequency/);
});

test('materialize enumeration uses database claimedAt instead of app clock', () => {
  const enumeration = enumerateDueMaterializePeriods({
    asOf: '2026-07-20T01:00:00Z',
    frequency: 'weekly',
    limit: 2,
    nextRunAt: '2026-07-06T01:00:00Z',
  });
  assert.equal(enumeration.periods.length, 2);
  assert.equal(enumeration.hasMore, true);
  assert.equal(enumeration.nextRunAt, '2026-07-20T01:00:00.000Z');
});

test('materialize enumeration with lagging app clock would miss due slots', () => {
  const withClaimedAt = enumerateDueMaterializePeriods({
    asOf: '2026-07-20T01:00:00Z',
    frequency: 'weekly',
    limit: 2,
    nextRunAt: '2026-07-06T01:00:00Z',
  });
  const withLaggingClock = enumerateDueMaterializePeriods({
    asOf: '2026-07-09T01:00:00Z',
    frequency: 'weekly',
    limit: 2,
    nextRunAt: '2026-07-06T01:00:00Z',
  });
  assert.equal(withClaimedAt.periods.length, 2);
  assert.equal(withLaggingClock.periods.length, 1);
  assert.equal(withLaggingClock.nextRunAt, '2026-07-13T01:00:00.000Z');
});
