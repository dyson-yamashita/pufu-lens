import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertReportScheduleSaveAllowed,
  buildReportScheduleSettingsView,
  createDefaultReportScheduleSettingsView,
  describeReportScheduleActivation,
  hasActiveReportScheduleLease,
  parseReportScheduleFrequencyInput,
  parseReportSchedulePeriodRunSummaryRow,
  ReportScheduleSaveBlockedError,
  resolveReportScheduleNextRunAt,
  shouldResetReportScheduleExecutionState,
} from './report-schedule-settings.ts';

test('report schedule frequency input accepts only canonical values', () => {
  assert.equal(parseReportScheduleFrequencyInput('weekly'), 'weekly');
  assert.equal(parseReportScheduleFrequencyInput('none'), 'none');
  for (const invalid of ['moxthly', 'annualy', 'yearly', '']) {
    assert.throws(() => parseReportScheduleFrequencyInput(invalid), /frequency must be one of/);
  }
});

test('next run transitions set null for none and compute active slots', () => {
  assert.equal(
    resolveReportScheduleNextRunAt({
      asOf: '2026-07-19T23:00:00Z',
      frequency: 'none',
      runTime: '10:00',
    }),
    null,
  );
  assert.equal(
    resolveReportScheduleNextRunAt({
      asOf: '2026-07-19T23:00:00Z',
      frequency: 'weekly',
      runTime: '10:00',
    }),
    '2026-07-20T01:00:00.000Z',
  );
});

test('execution state resets only when frequency changes', () => {
  assert.equal(
    shouldResetReportScheduleExecutionState({
      nextFrequency: 'weekly',
      previousFrequency: 'weekly',
    }),
    false,
  );
  assert.equal(
    shouldResetReportScheduleExecutionState({
      nextFrequency: 'monthly',
      previousFrequency: 'weekly',
    }),
    true,
  );
  assert.equal(
    shouldResetReportScheduleExecutionState({
      nextFrequency: 'none',
      previousFrequency: 'weekly',
    }),
    true,
  );
});

test('activation notes explain first activation and active-to-active changes', () => {
  assert.match(
    describeReportScheduleActivation({
      frequency: 'weekly',
      previousFrequency: 'none',
    }) ?? '',
    /1件の履歴レポート/,
  );
  assert.match(
    describeReportScheduleActivation({
      frequency: 'monthly',
      previousFrequency: 'weekly',
    }) ?? '',
    /次回の定期実行/,
  );
  assert.equal(
    describeReportScheduleActivation({
      frequency: 'weekly',
      previousFrequency: 'weekly',
    }),
    null,
  );
});

test('default settings view represents disabled schedule state', () => {
  assert.deepEqual(createDefaultReportScheduleSettingsView(), {
    frequency: 'none',
    lastError: null,
    lastFailedAt: null,
    lastStartedAt: null,
    lastSucceededAt: null,
    nextRunAt: null,
    periodRunSummary: {
      backfillRemaining: 0,
      pending: 0,
      retryExhausted: 0,
      retryWait: 0,
      running: 0,
      skipped: 0,
      succeeded: 0,
    },
    recentPeriodRuns: [],
    retryCount: 0,
    runTime: '10:00',
    scheduleId: null,
    timezone: 'Asia/Tokyo',
  });
});

test('settings view falls back to defaults when schedule row is missing', () => {
  assert.deepEqual(
    buildReportScheduleSettingsView({
      periodRunSummary: createDefaultReportScheduleSettingsView().periodRunSummary,
      recentPeriodRuns: [],
      schedule: null,
    }),
    createDefaultReportScheduleSettingsView(),
  );
});

test('period run summary rows are runtime validated', () => {
  assert.deepEqual(
    parseReportSchedulePeriodRunSummaryRow({
      backfillRemaining: 2,
      pending: 3,
      retryExhausted: 0,
      retryWait: 1,
      running: 0,
      skipped: 1,
      succeeded: 4,
    }),
    {
      backfillRemaining: 2,
      pending: 3,
      retryExhausted: 0,
      retryWait: 1,
      running: 0,
      skipped: 1,
      succeeded: 4,
    },
  );
});

test('report schedule settings repository scopes reads and writes by project', async () => {
  const source = await readFile(new URL('./report-schedule-settings.ts', import.meta.url), 'utf8');
  assert.match(source, /period_run\.project_id = \$\{input\.projectId\}/);
  assert.match(source, /schedule\.project_id = \$\{input\.projectId\}/);
  assert.match(source, /period_run\.frequency = \$\{input\.frequency\}/);
  assert.match(source, /ON CONFLICT \(project_id\) DO UPDATE/);
  assert.match(
    source,
    /ON CONFLICT \(project_id, frequency, period_start, period_end\) DO NOTHING/,
  );
  assert.match(source, /'scheduled_backfill'/);
  assert.match(source, /shouldEnqueueInitialReportBackfill/);
  assert.match(source, /resolveInitialAggregateBackfillPeriod/);
  assert.doesNotMatch(source, /enumerateBackfillScheduledReportPeriods/);
  assert.doesNotMatch(source, /while \(hasMore\)/);
  assert.match(source, /run_kind = 'scheduled_backfill'/);
  assert.match(source, /status NOT IN \('succeeded', 'skipped'\)/);
  assert.match(source, /"backfillRemaining"/);
});

test('report schedule period run summary filters by current schedule frequency', async () => {
  const source = await readFile(new URL('./report-schedule-settings.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /readReportSchedulePeriodRunSummary\(sql, \{\s*frequency: schedule\.frequency,/,
  );
  const summaryBlock = source.slice(
    source.indexOf('export async function readReportSchedulePeriodRunSummary'),
    source.indexOf('export function parseReportSchedulePeriodRunSummaryRow'),
  );
  assert.match(summaryBlock, /period_run\.frequency = \$\{input\.frequency\}/);
});

test('report schedule save runs schedule transition and backfill enqueue in one transaction', async () => {
  const source = await readFile(new URL('./report-schedule-settings.ts', import.meta.url), 'utf8');
  const saveBlock = source.slice(source.indexOf('export async function saveProjectReportSchedule'));
  assert.match(saveBlock, /return sql\.begin/);
  assert.match(saveBlock, /lockProjectRowForReportScheduleSave\(tx/);
  assert.match(saveBlock, /readLockedProjectReportSchedule\(tx/);
  assert.match(saveBlock, /assertReportScheduleSaveAllowed\(existing/);
  assert.match(saveBlock, /resolveReportScheduleNextRunAt\(/);
  assert.match(saveBlock, /upsertProjectReportScheduleRow\(tx/);
  assert.match(saveBlock, /enqueueInitialBackfillPeriodRuns\(tx/);
  assert.doesNotMatch(saveBlock, /readProjectReportSchedule\(sql/);
});

test('active dispatcher leases block schedule saves instead of being cleared', () => {
  const activeLease = {
    leaseExpiresAt: '2026-07-20T02:00:00.000Z',
    workerToken: 'worker-1',
  };
  assert.equal(hasActiveReportScheduleLease(activeLease, '2026-07-20T01:00:00.000Z'), true);
  assert.equal(hasActiveReportScheduleLease(activeLease, '2026-07-20T03:00:00.000Z'), false);
  assert.throws(
    () =>
      assertReportScheduleSaveAllowed(
        {
          ...activeLease,
          createdAt: '2026-07-20T00:00:00.000Z',
          createdBy: null,
          frequency: 'weekly',
          id: 'schedule-1',
          lastError: null,
          lastFailedAt: null,
          lastStartedAt: null,
          lastSucceededAt: null,
          nextRunAt: '2026-07-20T01:00:00.000Z',
          projectId: 'project-1',
          retryCount: 0,
          runTime: '10:00',
          timezone: 'Asia/Tokyo',
          updatedAt: '2026-07-20T00:00:00.000Z',
          updatedBy: null,
        },
        '2026-07-20T01:00:00.000Z',
      ),
    ReportScheduleSaveBlockedError,
  );
});

test('reports page renders private reports before the schedule panel', async () => {
  const page = await readFile(
    new URL('../app/projects/[projectSlug]/reports/page.tsx', import.meta.url),
    'utf8',
  );
  const reportsListMarker = 'data-testid="reports-list-panel"';
  const schedulePanelMarker = '<ReportSchedulePanel';
  const reportsListIndex = page.indexOf(reportsListMarker);
  const schedulePanelIndex = page.indexOf(schedulePanelMarker);
  assert.notEqual(reportsListIndex, -1, 'reports list panel marker must exist');
  assert.notEqual(schedulePanelIndex, -1, 'report schedule panel marker must exist');
  assert.ok(
    reportsListIndex < schedulePanelIndex,
    'reports list panel must render before report schedule panel',
  );
});

test('report schedule panel explains aggregated initial history report', async () => {
  const panel = await readFile(new URL('./report-schedule-panel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /1件の履歴レポート/);
});

test('report schedule panel renders the timezone note after recent period run results', async () => {
  const panel = await readFile(new URL('./report-schedule-panel.tsx', import.meta.url), 'utf8');
  const recentRunsEmptyIndex = panel.indexOf('data-testid="report-schedule-recent-runs-empty"');
  const timezoneNoteIndex = panel.indexOf('data-testid="report-schedule-timezone-note"');
  assert.notEqual(recentRunsEmptyIndex, -1, 'recent period run empty state must exist');
  assert.notEqual(timezoneNoteIndex, -1, 'timezone note must exist');
  assert.ok(
    recentRunsEmptyIndex < timezoneNoteIndex,
    'timezone note must render after recent period run results',
  );
});

test('report schedule panel imports presentation helpers without SQL modules', async () => {
  const panel = await readFile(new URL('./report-schedule-panel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /from '\.\/report-schedule-presentation\.ts'/);
  assert.match(panel, /from '\.\/report-schedule-contract\.ts'/);
  assert.doesNotMatch(panel, /from '\.\/report-schedule-settings\.ts'/);
  assert.doesNotMatch(panel, /from '\.\/report-schedules\.ts'/);
});

test('updateProjectReportSchedule uses the shared admin save helper', async () => {
  const actions = await readFile(
    new URL('./admin-report-schedule-actions.ts', import.meta.url),
    'utf8',
  );
  assert.match(actions, /saveProjectReportScheduleForAdmin/);
  assert.doesNotMatch(actions, /requireAdminProject/);
});

test('report schedule presentation depends only on the client-safe contract', async () => {
  const presentation = await readFile(
    new URL('./report-schedule-presentation.ts', import.meta.url),
    'utf8',
  );
  assert.match(presentation, /from '\.\/report-schedule-contract\.ts'/);
  assert.doesNotMatch(presentation, /from '\.\/report-schedules\.ts'/);
  assert.doesNotMatch(presentation, /from '\.\/report-schedule-settings\.ts'/);
});

test('save path locks the project row and schedule state inside the transaction', async () => {
  const source = await readFile(new URL('./report-schedule-settings.ts', import.meta.url), 'utf8');
  assert.match(source, /FROM public\.projects AS project[\s\S]*FOR UPDATE/);
  assert.match(source, /readLockedProjectReportSchedule[\s\S]*FOR UPDATE OF schedule/);
  assert.match(source, /assertReportScheduleSaveAllowed/);
  assert.match(source, /lease_expires_at <= now\(\) THEN NULL/);
});
