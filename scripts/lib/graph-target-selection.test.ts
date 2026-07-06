import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgtypeString, selectMissingGraphTargets } from './graph-target-selection.ts';

test('selectMissingGraphTargets keeps the original order and returns only unregistered rows', () => {
  const rows = [
    { graphNodeId: 'document:a', sourceId: 'a' },
    { graphNodeId: 'document:b', sourceId: 'b' },
    { graphNodeId: 'document:c', sourceId: 'c' },
    { graphNodeId: 'document:d', sourceId: 'd' },
  ];

  assert.deepEqual(
    selectMissingGraphTargets(rows, new Set(['document:a', 'document:c']), 2).map(
      (row) => row.sourceId,
    ),
    ['b', 'd'],
  );
});

test('selectMissingGraphTargets applies the limit after filtering registered rows', () => {
  const rows = [
    { graphNodeId: 'document:a' },
    { graphNodeId: 'document:b' },
    { graphNodeId: 'document:c' },
  ];

  assert.deepEqual(selectMissingGraphTargets(rows, new Set(['document:a']), 1), [
    { graphNodeId: 'document:b' },
  ]);
});

test('parseAgtypeString parses AGE quoted strings', () => {
  assert.equal(parseAgtypeString('"document:pulls/477"'), 'document:pulls/477');
  assert.equal(parseAgtypeString('document:pulls/478'), 'document:pulls/478');
  assert.equal(parseAgtypeString(''), undefined);
  assert.equal(parseAgtypeString(42), undefined);
  assert.equal(parseAgtypeString('"unterminated'), undefined);
});
