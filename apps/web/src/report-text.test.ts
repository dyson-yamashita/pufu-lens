import assert from 'node:assert/strict';
import { truncateCodePoints } from './report-text.ts';

assert.equal(truncateCodePoints('hello', 0), '');
assert.equal(truncateCodePoints('hello', -1), '');
assert.equal(truncateCodePoints('hello', 1), '…');
assert.equal(truncateCodePoints('hello', 3), 'he…');
assert.equal(truncateCodePoints('hello', 5), 'hello');
assert.equal(truncateCodePoints('👨‍👩‍👧‍👦', 1), '…');
assert.equal(truncateCodePoints('👨‍👩‍👧‍👦', 2), '👨…');

console.log('report-text.test.ts: ok');
