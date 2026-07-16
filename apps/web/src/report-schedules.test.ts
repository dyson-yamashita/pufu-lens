import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  isReportScheduleFrequency,
  isReportScheduleRunKind,
  isReportScheduleRunStatus,
  isScheduledReportFrequency,
  parseProjectReportScheduleRow,
  parseReportSchedulePeriodRunRow,
} from './report-schedules.ts';

const validScheduleRow = {
  createdAt: '2026-07-16T01:00:00Z',
  createdBy: 'user-1',
  frequency: 'weekly',
  id: 'schedule-1',
  lastError: null,
  lastFailedAt: null,
  lastStartedAt: null,
  lastSucceededAt: '2026-07-14T01:00:00Z',
  leaseExpiresAt: null,
  nextRunAt: '2026-07-20T01:00:00Z',
  projectId: 'project-1',
  retryCount: 0,
  runTime: '10:00:00',
  timezone: 'Asia/Tokyo',
  updatedAt: '2026-07-16T01:00:00Z',
  updatedBy: 'user-1',
  workerToken: null,
} as const;

const validPeriodRunRow = {
  attemptCount: 0,
  completedAt: null,
  createdAt: '2026-07-16T01:00:00Z',
  frequency: 'weekly',
  id: 'period-run-1',
  lastError: null,
  leaseExpiresAt: null,
  nextAttemptAt: null,
  notificationSentAt: null,
  periodEnd: '2026-07-12',
  periodStart: '2026-07-06',
  projectId: 'project-1',
  reportId: null,
  runKind: 'scheduled',
  scheduleId: 'schedule-1',
  skipReason: null,
  startedAt: null,
  status: 'pending',
  updatedAt: '2026-07-16T01:00:00Z',
  workerToken: null,
} as const;

test('report schedule enums accept only canonical values', () => {
  for (const frequency of ['none', 'weekly', 'monthly', 'annually']) {
    assert.equal(isReportScheduleFrequency(frequency), true);
  }
  for (const frequency of ['weekly', 'monthly', 'annually']) {
    assert.equal(isScheduledReportFrequency(frequency), true);
  }
  for (const invalid of ['moxthly', 'annualy', 'yearly', '', null]) {
    assert.equal(isReportScheduleFrequency(invalid), false);
    assert.equal(isScheduledReportFrequency(invalid), false);
  }
  assert.equal(isScheduledReportFrequency('none'), false);
  assert.equal(isReportScheduleRunKind('scheduled'), true);
  assert.equal(isReportScheduleRunKind('scheduled_backfill'), true);
  assert.equal(isReportScheduleRunKind('manual'), false);
  assert.equal(isReportScheduleRunStatus('retry_exhausted'), true);
  assert.equal(isReportScheduleRunStatus('failed'), false);
});

test('project report schedule rows are normalized and cross-field validated', () => {
  assert.deepEqual(parseProjectReportScheduleRow(validScheduleRow), {
    ...validScheduleRow,
    createdAt: '2026-07-16T01:00:00.000Z',
    lastSucceededAt: '2026-07-14T01:00:00.000Z',
    nextRunAt: '2026-07-20T01:00:00.000Z',
    runTime: '10:00',
    updatedAt: '2026-07-16T01:00:00.000Z',
  });
  assert.deepEqual(
    parseProjectReportScheduleRow({
      ...validScheduleRow,
      frequency: 'none',
      nextRunAt: null,
    }),
    {
      ...validScheduleRow,
      createdAt: '2026-07-16T01:00:00.000Z',
      frequency: 'none',
      lastSucceededAt: '2026-07-14T01:00:00.000Z',
      nextRunAt: null,
      runTime: '10:00',
      updatedAt: '2026-07-16T01:00:00.000Z',
    },
  );
  assert.throws(
    () => parseProjectReportScheduleRow({ ...validScheduleRow, frequency: 'moxthly' }),
    /frequency/,
  );
  assert.throws(
    () => parseProjectReportScheduleRow({ ...validScheduleRow, nextRunAt: null }),
    /disagree/,
  );
  assert.throws(
    () =>
      parseProjectReportScheduleRow({
        ...validScheduleRow,
        leaseExpiresAt: '2026-07-16T01:10:00Z',
      }),
    /lease pair/,
  );
});

test('period-run rows preserve report-less skipped history', () => {
  const skipped = parseReportSchedulePeriodRunRow({
    ...validPeriodRunRow,
    completedAt: '2026-07-16T01:05:00Z',
    notificationSentAt: '2026-07-16T01:06:00Z',
    runKind: 'scheduled_backfill',
    skipReason: 'no_documents',
    status: 'skipped',
  });

  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reportId, null);
  assert.equal(skipped.skipReason, 'no_documents');
  assert.equal(skipped.completedAt, '2026-07-16T01:05:00.000Z');
  assert.equal(skipped.notificationSentAt, '2026-07-16T01:06:00.000Z');

  const succeeded = parseReportSchedulePeriodRunRow({
    ...validPeriodRunRow,
    completedAt: '2026-07-16T01:05:00Z',
    reportId: 'report-1',
    status: 'succeeded',
  });
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.reportId, 'report-1');
});

test('period-run rows reject invalid state and period combinations', () => {
  assert.throws(
    () => parseReportSchedulePeriodRunRow({ ...validPeriodRunRow, frequency: 'none' }),
    /frequency/,
  );
  assert.throws(
    () => parseReportSchedulePeriodRunRow({ ...validPeriodRunRow, status: 'skipped' }),
    /skipped state/,
  );
  assert.throws(
    () => parseReportSchedulePeriodRunRow({ ...validPeriodRunRow, status: 'retry_wait' }),
    /nextAttemptAt/,
  );
  assert.throws(
    () => parseReportSchedulePeriodRunRow({ ...validPeriodRunRow, status: 'succeeded' }),
    /requires reportId and completedAt/,
  );
  assert.throws(
    () => parseReportSchedulePeriodRunRow({ ...validPeriodRunRow, reportId: 'report-1' }),
    /only allowed for succeeded runs/,
  );
  assert.throws(
    () =>
      parseReportSchedulePeriodRunRow({
        ...validPeriodRunRow,
        periodEnd: '2026-07-01',
      }),
    /periodStart is after periodEnd/,
  );
  assert.throws(
    () => parseReportSchedulePeriodRunRow({ ...validPeriodRunRow, periodStart: '2026-02-30' }),
    /periodStart/,
  );
});

test('report schedule repository scopes schedule and period-run reads by project', async () => {
  const source = await readFile(new URL('./report-schedules.ts', import.meta.url), 'utf8');

  assert.match(source, /schedule\.project_id = \$\{input\.projectId\}/);
  assert.match(source, /period_run\.project_id = \$\{input\.projectId\}/);
  assert.match(source, /period_run\.schedule_id = \$\{input\.scheduleId\}/);
  assert.match(source, /schedule\.id = period_run\.schedule_id/);
  assert.match(source, /schedule\.project_id = period_run\.project_id/);
  assert.match(source, /as readonly unknown\[\]/);
});
