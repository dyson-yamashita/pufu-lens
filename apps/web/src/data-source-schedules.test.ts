import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  isSchedulableSourceType,
  parseDataSourceScheduleRow,
  requireDailyTime,
} from './data-source-schedules.ts';

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
