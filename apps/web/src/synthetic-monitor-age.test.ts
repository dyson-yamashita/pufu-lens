import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSyntheticMonitorAgeCountRows } from './synthetic-monitor-age.ts';

test('parseSyntheticMonitorAgeCountRows accepts number, bigint, and integer string values', () => {
  assert.equal(parseSyntheticMonitorAgeCountRows([{ value: 3 }], 'count'), 3);
  assert.equal(parseSyntheticMonitorAgeCountRows([{ value: 0n }], 'count'), 0);
  assert.equal(parseSyntheticMonitorAgeCountRows([{ value: '42' }], 'count'), 42);
});

test('parseSyntheticMonitorAgeCountRows rejects malformed rows', () => {
  assert.throws(() => parseSyntheticMonitorAgeCountRows([], 'count'), /expected 1 row, received 0/);
  assert.throws(
    () => parseSyntheticMonitorAgeCountRows([{ value: { nodeCount: 1 } }], 'count'),
    /not a safe non-negative integer/,
  );
  assert.throws(
    () => parseSyntheticMonitorAgeCountRows([{ value: -1 }], 'count'),
    /not a safe non-negative integer/,
  );
  assert.throws(
    () => parseSyntheticMonitorAgeCountRows([{ value: '1.5' }], 'count'),
    /not a safe non-negative integer/,
  );
});
