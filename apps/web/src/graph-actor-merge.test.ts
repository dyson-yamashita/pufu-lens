import assert from 'node:assert/strict';
import { parseActorGraphCountRows } from './graph-actor-merge.ts';

assert.equal(parseActorGraphCountRows([{ value: 1 }], 'sample count'), 1);
assert.equal(parseActorGraphCountRows([{ value: '2' }], 'sample count'), 2);
assert.equal(parseActorGraphCountRows([{ value: 3n }], 'sample count'), 3);
assert.throws(
  () => parseActorGraphCountRows([], 'sample count'),
  /Invalid AGE sample count: expected 1 row, received 0/,
);
assert.throws(
  () => parseActorGraphCountRows([{ value: '1.5' }], 'sample count'),
  /Invalid AGE sample count: value is not a safe integer/,
);

console.log('web graph actor merge tests passed');
