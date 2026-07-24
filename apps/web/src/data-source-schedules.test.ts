import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DEFAULT_SCHEDULE_TIME,
  isSchedulableSourceType,
  parseDataSourceScheduleRow,
  requireDailyTime,
  SCHEDULE_TIMEZONE,
} from './data-source-schedules.ts';
import { DEFAULT_REPORT_SCHEDULE_RUN_TIME } from './report-schedule-contract.ts';

test('new data source schedules default to 06:00 while report schedules stay 10:00', () => {
  assert.equal(DEFAULT_SCHEDULE_TIME, '06:00');
  assert.equal(DEFAULT_REPORT_SCHEDULE_RUN_TIME, '10:00');
});

test('default schedule insert SQL uses strict before-slot comparison in Asia/Tokyo', async () => {
  const source = await readFile(new URL('./data-source-schedules.ts', import.meta.url), 'utf8');
  const insertSql = source.slice(
    source.indexOf('export async function insertDefaultDataSourceSchedule'),
    source.indexOf('export async function readDataSourceSchedule'),
  );

  assert.match(insertSql, /\$\{DEFAULT_SCHEDULE_TIME\}::time/);
  assert.match(insertSql, /\$\{SCHEDULE_TIMEZONE\}/);
  assert.match(
    insertSql,
    /\(now\(\) AT TIME ZONE \$\{SCHEDULE_TIMEZONE\}\)::time < \$\{DEFAULT_SCHEDULE_TIME\}::time/,
  );
  assert.doesNotMatch(
    insertSql,
    /\(now\(\) AT TIME ZONE \$\{SCHEDULE_TIMEZONE\}\)::time <= \$\{DEFAULT_SCHEDULE_TIME\}::time/,
  );
  assert.match(insertSql, /THEN \(now\(\) AT TIME ZONE \$\{SCHEDULE_TIMEZONE\}\)::date/);
  assert.match(insertSql, /ELSE \(now\(\) AT TIME ZONE \$\{SCHEDULE_TIMEZONE\}\)::date \+ 1/);
  assert.match(insertSql, /END \+ \$\{DEFAULT_SCHEDULE_TIME\}::time/);
  assert.match(insertSql, /\) AT TIME ZONE \$\{SCHEDULE_TIMEZONE\}/);
  assert.equal(SCHEDULE_TIMEZONE, 'Asia/Tokyo');
});

test('schedule update SQL uses strict before-slot comparison in Asia/Tokyo', async () => {
  const source = await readFile(new URL('./data-source-schedules.ts', import.meta.url), 'utf8');
  const updateSql = source.slice(
    source.indexOf('export async function updateDataSourceScheduleRow'),
    source.indexOf('function requireString'),
  );

  assert.match(
    updateSql,
    /\(now\(\) AT TIME ZONE \$\{SCHEDULE_TIMEZONE\}\)::time < \$\{dailyTime\}::time/,
  );
  assert.doesNotMatch(
    updateSql,
    /\(now\(\) AT TIME ZONE \$\{SCHEDULE_TIMEZONE\}\)::time <= \$\{dailyTime\}::time/,
  );
  assert.match(updateSql, /THEN \(now\(\) AT TIME ZONE \$\{SCHEDULE_TIMEZONE\}\)::date/);
  assert.match(updateSql, /ELSE \(now\(\) AT TIME ZONE \$\{SCHEDULE_TIMEZONE\}\)::date \+ 1/);
  assert.match(updateSql, /END \+ \$\{dailyTime\}::time/);
  assert.match(updateSql, /\) AT TIME ZONE \$\{SCHEDULE_TIMEZONE\}/);
});

test('only provider-backed non-web sources are schedulable', () => {
  assert.equal(isSchedulableSourceType('github'), true);
  assert.equal(isSchedulableSourceType('drive'), true);
  assert.equal(isSchedulableSourceType('gmail'), true);
  assert.equal(isSchedulableSourceType('web'), false);
});

test('daily time accepts a strict 24-hour HH:mm value', () => {
  assert.equal(requireDailyTime('00:00'), '00:00');
  assert.equal(requireDailyTime('23:59'), '23:59');
  assert.equal(requireDailyTime('10:00:00'), '10:00');
  assert.throws(() => requireDailyTime('24:00'), /dailyTime/);
});

test('schedule SQL rows are runtime validated and timestamps normalized', () => {
  assert.deepEqual(
    parseDataSourceScheduleRow({
      dailyTime: '10:00:00',
      enabled: true,
      lastError: null,
      lastFailedAt: null,
      lastSucceededAt: new Date('2026-07-11T01:00:00Z'),
      nextRunAt: '2026-07-12T01:00:00Z',
      retryCount: 0,
      timezone: 'Asia/Tokyo',
    }),
    {
      dailyTime: '10:00',
      enabled: true,
      lastError: null,
      lastFailedAt: null,
      lastSucceededAt: '2026-07-11T01:00:00.000Z',
      nextRunAt: '2026-07-12T01:00:00.000Z',
      retryCount: 0,
      timezone: 'Asia/Tokyo',
    },
  );
  assert.throws(() => parseDataSourceScheduleRow({}), /schedule row field/);
});

test('schedule repository scopes reads and updates by project and data source', async () => {
  const source = await readFile(new URL('./data-source-schedules.ts', import.meta.url), 'utf8');
  assert.match(source, /schedule\.project_id = \$\{input\.projectId\}/);
  assert.match(source, /schedule\.data_source_id = \$\{input\.dataSourceId\}/);
  assert.match(source, /source\.project_id = schedule\.project_id/);
  assert.match(source, /source\.source_type IN \('github', 'drive', 'gmail'\)/);
});

test('data source creation inserts the default schedule inside its transaction', async () => {
  const source = await readFile(new URL('./admin-data-source-actions.ts', import.meta.url), 'utf8');
  const transaction = source.slice(
    source.indexOf('await sql.begin'),
    source.indexOf('try {', source.indexOf('await sql.begin')),
  );
  assert.match(transaction, /insertDefaultDataSourceSchedule\(tx/);
  assert.match(transaction, /sourceType/);
});
