import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enumerateBackfillScheduledReportPeriods,
  enumerateDueScheduledReportPeriods,
  resolveNextScheduledReportRunAt,
  resolveScheduledReportPeriod,
  shouldEnqueueInitialReportBackfill,
} from './report-schedule-periods.ts';

test('schedule slots resolve the previous completed calendar period in Asia/Tokyo', () => {
  assert.deepEqual(resolveScheduledReportPeriod('2026-07-20T01:00:00Z', 'weekly'), {
    end: '2026-07-19',
    start: '2026-07-13',
  });
  assert.deepEqual(resolveScheduledReportPeriod('2026-03-01T01:00:00Z', 'monthly'), {
    end: '2026-02-28',
    start: '2026-02-01',
  });
  assert.deepEqual(resolveScheduledReportPeriod('2025-03-01T01:00:00Z', 'monthly'), {
    end: '2025-02-28',
    start: '2025-02-01',
  });
  assert.deepEqual(resolveScheduledReportPeriod('2026-01-01T01:00:00Z', 'annually'), {
    end: '2025-12-31',
    start: '2025-01-01',
  });
});

test('Tokyo schedule slots keep the same UTC hour across overseas DST seasons', () => {
  assert.deepEqual(resolveScheduledReportPeriod('2026-01-05T01:00:00Z', 'weekly'), {
    end: '2026-01-04',
    start: '2025-12-29',
  });
  assert.deepEqual(resolveScheduledReportPeriod('2026-07-06T01:00:00Z', 'weekly'), {
    end: '2026-07-05',
    start: '2026-06-29',
  });
});

test('next run uses the next strict calendar boundary at the configured Tokyo wall clock', () => {
  assert.equal(
    resolveNextScheduledReportRunAt({
      asOf: '2026-07-19T23:00:00Z',
      frequency: 'weekly',
      runTime: '10:00',
    }),
    '2026-07-20T01:00:00.000Z',
  );
  assert.equal(
    resolveNextScheduledReportRunAt({
      asOf: '2026-07-20T01:00:00Z',
      frequency: 'weekly',
      runTime: '10:00:00',
    }),
    '2026-07-27T01:00:00.000Z',
  );
  assert.equal(
    resolveNextScheduledReportRunAt({
      asOf: '2026-07-31T15:00:00Z',
      frequency: 'monthly',
      runTime: '10:00',
    }),
    '2026-08-01T01:00:00.000Z',
  );
  assert.equal(
    resolveNextScheduledReportRunAt({
      asOf: '2026-01-01T01:00:00Z',
      frequency: 'annually',
      runTime: '10:00',
    }),
    '2027-01-01T01:00:00.000Z',
  );
});

test('due enumeration catches up from persisted nextRunAt in oldest-first bounded chunks', () => {
  const first = enumerateDueScheduledReportPeriods({
    asOf: '2026-07-20T01:00:00Z',
    frequency: 'weekly',
    limit: 2,
    nextRunAt: '2026-07-06T01:00:00Z',
  });
  assert.deepEqual(first, {
    hasMore: true,
    nextRunAt: '2026-07-20T01:00:00.000Z',
    periods: [
      {
        end: '2026-07-05',
        scheduledFor: '2026-07-06T01:00:00.000Z',
        start: '2026-06-29',
      },
      {
        end: '2026-07-12',
        scheduledFor: '2026-07-13T01:00:00.000Z',
        start: '2026-07-06',
      },
    ],
  });
  assert.deepEqual(
    enumerateDueScheduledReportPeriods({
      asOf: '2026-07-20T01:00:00Z',
      frequency: 'weekly',
      limit: 2,
      nextRunAt: first.nextRunAt,
    }),
    {
      hasMore: false,
      nextRunAt: '2026-07-27T01:00:00.000Z',
      periods: [
        {
          end: '2026-07-19',
          scheduledFor: '2026-07-20T01:00:00.000Z',
          start: '2026-07-13',
        },
      ],
    },
  );
});

test('monthly and annual due enumeration advances canonical calendar slots', () => {
  assert.deepEqual(
    enumerateDueScheduledReportPeriods({
      asOf: '2026-09-01T01:00:00Z',
      frequency: 'monthly',
      limit: 10,
      nextRunAt: '2026-07-01T01:00:00Z',
    }).periods.map(({ end, start }) => ({ end, start })),
    [
      { end: '2026-06-30', start: '2026-06-01' },
      { end: '2026-07-31', start: '2026-07-01' },
      { end: '2026-08-31', start: '2026-08-01' },
    ],
  );
  assert.deepEqual(
    enumerateDueScheduledReportPeriods({
      asOf: '2026-01-01T01:00:00Z',
      frequency: 'annually',
      limit: 10,
      nextRunAt: '2025-01-01T01:00:00Z',
    }).periods.map(({ end, start }) => ({ end, start })),
    [
      { end: '2024-12-31', start: '2024-01-01' },
      { end: '2025-12-31', start: '2025-01-01' },
    ],
  );
});

test('backfill enumeration starts at available data and excludes the active period', () => {
  const first = enumerateBackfillScheduledReportPeriods({
    asOf: '2026-07-16T03:00:00Z',
    availableFrom: '2026-06-03',
    frequency: 'weekly',
    limit: 2,
  });
  assert.deepEqual(first, {
    hasMore: true,
    nextPeriodStart: '2026-06-15',
    periods: [
      { end: '2026-06-07', start: '2026-06-01' },
      { end: '2026-06-14', start: '2026-06-08' },
    ],
  });
  const remaining = enumerateBackfillScheduledReportPeriods({
    asOf: '2026-07-16T03:00:00Z',
    availableFrom: '2026-06-03',
    frequency: 'weekly',
    limit: 10,
    periodStartCursor: first.nextPeriodStart ?? undefined,
  });
  assert.deepEqual(remaining.periods.at(-1), { end: '2026-07-12', start: '2026-07-06' });
  assert.equal(
    remaining.periods.some((period) => period.start === '2026-07-13'),
    false,
  );
  assert.equal(remaining.hasMore, false);
});

test('monthly and annual backfill handle leap years and completed periods only', () => {
  assert.deepEqual(
    enumerateBackfillScheduledReportPeriods({
      asOf: '2024-03-15T01:00:00Z',
      availableFrom: '2024-01-20',
      frequency: 'monthly',
      limit: 10,
    }).periods,
    [
      { end: '2024-01-31', start: '2024-01-01' },
      { end: '2024-02-29', start: '2024-02-01' },
    ],
  );
  assert.deepEqual(
    enumerateBackfillScheduledReportPeriods({
      asOf: '2026-07-16T01:00:00Z',
      availableFrom: '2024-08-01',
      frequency: 'annually',
      limit: 10,
    }).periods,
    [
      { end: '2024-12-31', start: '2024-01-01' },
      { end: '2025-12-31', start: '2025-01-01' },
    ],
  );
});

test('initial backfill is limited to first activation without same-frequency reports', () => {
  assert.equal(
    shouldEnqueueInitialReportBackfill({
      hasScheduledReportForFrequency: false,
      nextFrequency: 'weekly',
      previousFrequency: 'none',
    }),
    true,
  );
  assert.equal(
    shouldEnqueueInitialReportBackfill({
      hasScheduledReportForFrequency: true,
      nextFrequency: 'weekly',
      previousFrequency: 'none',
    }),
    false,
  );
  assert.equal(
    shouldEnqueueInitialReportBackfill({
      hasScheduledReportForFrequency: false,
      nextFrequency: 'monthly',
      previousFrequency: 'weekly',
    }),
    false,
  );
  assert.equal(
    shouldEnqueueInitialReportBackfill({
      hasScheduledReportForFrequency: false,
      nextFrequency: 'none',
      previousFrequency: 'weekly',
    }),
    false,
  );
});

test('runTime accepts HH:mm and HH:mm:00 but rejects nonzero seconds', () => {
  assert.equal(
    resolveNextScheduledReportRunAt({
      asOf: '2026-07-19T23:00:00Z',
      frequency: 'weekly',
      runTime: '10:00:00',
    }),
    '2026-07-20T01:00:00.000Z',
  );
  assert.throws(
    () =>
      resolveNextScheduledReportRunAt({
        asOf: '2026-07-19T23:00:00Z',
        frequency: 'weekly',
        runTime: '10:00:30',
      }),
    /seconds must be zero/,
  );
  assert.throws(
    () =>
      resolveNextScheduledReportRunAt({
        asOf: '2026-07-19T23:00:00Z',
        frequency: 'weekly',
        runTime: '25:00',
      }),
    /HH:mm or HH:mm:00/,
  );
});

test('instant strings require an explicit UTC offset or Z designator', () => {
  assert.deepEqual(resolveScheduledReportPeriod('2026-07-20T01:00:00+00:00', 'weekly'), {
    end: '2026-07-19',
    start: '2026-07-13',
  });
  assert.throws(
    () => resolveScheduledReportPeriod('2026-07-20T01:00:00', 'weekly'),
    /explicit UTC offset or Z designator/,
  );
  assert.throws(
    () =>
      enumerateDueScheduledReportPeriods({
        asOf: '2026-07-20T01:00:00',
        frequency: 'weekly',
        limit: 1,
        nextRunAt: '2026-07-20T01:00:00Z',
      }),
    /asOf must include an explicit UTC offset or Z designator/,
  );
  const asOf = new Date('2026-07-20T01:00:00Z');
  const asOfValue = asOf.valueOf();
  assert.deepEqual(
    enumerateDueScheduledReportPeriods({
      asOf,
      frequency: 'weekly',
      limit: 1,
      nextRunAt: '2026-07-20T01:00:00Z',
    }).periods[0],
    {
      end: '2026-07-19',
      scheduledFor: '2026-07-20T01:00:00.000Z',
      start: '2026-07-13',
    },
  );
  assert.equal(asOf.valueOf(), asOfValue);
  assert.throws(
    () => resolveScheduledReportPeriod('not-a-dateZ', 'weekly'),
    /scheduledFor must be a valid instant/,
  );
});

test('enumeration rejects non-canonical boundaries and unbounded limits', () => {
  assert.throws(() => resolveScheduledReportPeriod('2026-07-21T01:00:00Z', 'weekly'), /Monday/);
  assert.throws(
    () =>
      enumerateBackfillScheduledReportPeriods({
        asOf: '2026-07-16T01:00:00Z',
        availableFrom: '2026-06-03',
        frequency: 'weekly',
        limit: 10,
        periodStartCursor: '2026-06-16',
      }),
    /canonical/,
  );
  assert.throws(
    () =>
      enumerateDueScheduledReportPeriods({
        asOf: '2026-07-20T01:00:00Z',
        frequency: 'weekly',
        limit: 501,
        nextRunAt: '2026-07-20T01:00:00Z',
      }),
    /limit/,
  );
});
