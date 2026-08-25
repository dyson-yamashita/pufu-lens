import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAgeInventoryStructuralLabels,
  validateGraphInventoryLimit,
} from './postgres-graph-inventory.ts';

test('validateGraphInventoryLimit accepts bounded positive integers', () => {
  assert.equal(validateGraphInventoryLimit(1), 1);
  assert.equal(validateGraphInventoryLimit(100_000), 100_000);
});

test('validateGraphInventoryLimit rejects invalid limits before SQL execution', () => {
  assert.throws(
    () => validateGraphInventoryLimit(0),
    /Graph inventory limit must be a positive integer/,
  );
  assert.throws(
    () => validateGraphInventoryLimit(100_001),
    /Graph inventory limit exceeds maximum/,
  );
  assert.throws(
    () => validateGraphInventoryLimit(Number.NaN),
    /Graph inventory limit must be a positive integer/,
  );
});

test('parseAgeInventoryStructuralLabels unions physical labels and graphLabels property', () => {
  assert.deepEqual(parseAgeInventoryStructuralLabels(['Document'], ['Document', 'Issue']), [
    'Document',
    'Issue',
  ]);
});

test('parseAgeInventoryStructuralLabels normalizes reversed label order', () => {
  assert.deepEqual(
    parseAgeInventoryStructuralLabels(['Issue', 'Document'], ['Document', 'Issue']),
    ['Document', 'Issue'],
  );
});

test('parseAgeInventoryStructuralLabels preserves unexpected physical labels for drift detection', () => {
  assert.deepEqual(
    parseAgeInventoryStructuralLabels(['Document', 'Unexpected'], ['Document', 'Issue']),
    ['Document', 'Issue', 'Unexpected'],
  );
});

test('parseAgeInventoryStructuralLabels falls back to physical labels when graphLabels is null', () => {
  assert.deepEqual(parseAgeInventoryStructuralLabels(['Document'], null), ['Document']);
  assert.deepEqual(parseAgeInventoryStructuralLabels(['Document'], undefined), ['Document']);
});

test('parseAgeInventoryStructuralLabels rejects malformed graphLabels without raw identifiers', () => {
  assert.throws(
    () => parseAgeInventoryStructuralLabels(['Document'], 'not-json'),
    /Invalid AGE inventory graphLabels property/,
  );
  assert.throws(
    () => parseAgeInventoryStructuralLabels(['Document'], { labels: ['Issue'] }),
    /Invalid AGE inventory graphLabels property/,
  );
  assert.throws(() => parseAgeInventoryStructuralLabels(['Document'], ['']), /graphLabels entry/);
});
