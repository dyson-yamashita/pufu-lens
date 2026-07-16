import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  hasScheduledReportForFrequency,
  parsePreviousScheduledReportRow,
  readPreviousScheduledReport,
  readProjectReportAvailableFrom,
} from './report-schedule-planning.ts';

test('previous scheduled report rows are runtime validated', () => {
  assert.deepEqual(
    parsePreviousScheduledReportRow({
      id: 'report-1',
      periodEnd: '2026-07-12',
      periodStart: '2026-07-06',
      storageUri: 'project/reports/private/report-1.json',
    }),
    {
      id: 'report-1',
      periodEnd: '2026-07-12',
      periodStart: '2026-07-06',
      storageUri: 'project/reports/private/report-1.json',
    },
  );
  assert.throws(
    () =>
      parsePreviousScheduledReportRow({
        id: 'report-1',
        periodEnd: '2026-02-30',
        periodStart: '2026-02-01',
        storageUri: 'report.json',
      }),
    /periodEnd/,
  );
  assert.throws(
    () =>
      parsePreviousScheduledReportRow({
        id: 'report-1',
        periodEnd: '2026-07-01',
        periodStart: '2026-07-06',
        storageUri: 'report.json',
      }),
    /periodStart is after periodEnd/,
  );
});

test('planning queries parse database results', async () => {
  assert.equal(
    await hasScheduledReportForFrequency(createSqlReturning([{ hasReport: true }]), {
      frequency: 'weekly',
      projectId: 'project-1',
    }),
    true,
  );
  assert.deepEqual(
    await readPreviousScheduledReport(
      createSqlReturning([
        {
          id: 'report-1',
          periodEnd: '2026-07-12',
          periodStart: '2026-07-06',
          storageUri: 'project/reports/private/report-1.json',
        },
      ]),
      {
        beforePeriodStart: '2026-07-13',
        frequency: 'weekly',
        projectId: 'project-1',
      },
    ),
    {
      id: 'report-1',
      periodEnd: '2026-07-12',
      periodStart: '2026-07-06',
      storageUri: 'project/reports/private/report-1.json',
    },
  );
  assert.equal(
    await readProjectReportAvailableFrom(createSqlReturning([{ availableFrom: '2026-06-01' }]), {
      projectId: 'project-1',
    }),
    '2026-06-01',
  );
});

test('planning queries keep previous reports and data-start candidates project scoped', async () => {
  const planning = await readFile(
    new URL('./report-schedule-planning.ts', import.meta.url),
    'utf8',
  );
  const schedules = await readFile(new URL('./report-schedules.ts', import.meta.url), 'utf8');

  assert.match(planning, /report\.project_id = \$\{input\.projectId\}/);
  assert.match(planning, /report\.schedule_frequency = \$\{input\.frequency\}/);
  assert.match(planning, /report\.generation_kind IN \('scheduled', 'scheduled_backfill'\)/);
  assert.match(planning, /upper\(report\.period\) <= \$\{beforePeriodStart\}::date/);
  assert.match(planning, /document\.project_id = \$\{input\.projectId\}/);
  assert.match(planning, /link\.project_id = \$\{input\.projectId\}/);
  assert.match(schedules, /period_run\.status NOT IN \('succeeded', 'skipped'\)/);
  assert.match(schedules, /ORDER BY period_run\.period_start ASC, period_run\.id/);
});

function createSqlReturning(rows: readonly unknown[]) {
  const sql = async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows;
  return sql as unknown as Parameters<typeof hasScheduledReportForFrequency>[0];
}
