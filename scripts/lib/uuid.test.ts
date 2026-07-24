import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCanonicalUuid,
  isCanonicalUuid,
  parseOptionalCanonicalUuid,
  readCanonicalUuid,
} from './uuid.ts';

test('isCanonicalUuid accepts canonical UUID strings', () => {
  assert.equal(isCanonicalUuid('00000000-0000-0000-0000-000000000010'), true);
  assert.equal(isCanonicalUuid('10000000-0000-0000-0000-000000000658'), true);
});

test('isCanonicalUuid rejects malformed UUID strings', () => {
  assert.equal(isCanonicalUuid('00000000-0000-0000-0000-00000000000'), false);
  assert.equal(isCanonicalUuid('not-a-uuid'), false);
  assert.equal(isCanonicalUuid('00000000-0000-0000-0000-00000000gggg'), false);
});

test('readCanonicalUuid and assertCanonicalUuid preserve caller error messages', () => {
  assert.equal(
    readCanonicalUuid('00000000-0000-0000-0000-000000000010', '--data-source-id'),
    '00000000-0000-0000-0000-000000000010',
  );
  assert.throws(
    () => readCanonicalUuid('bad', '--data-source-id'),
    /--data-source-id must be a valid UUID/,
  );
  assert.throws(
    () => assertCanonicalUuid('bad', '--connection-id'),
    /--connection-id must be a valid UUID/,
  );
});

test('parseOptionalCanonicalUuid preserves null and undefined', () => {
  assert.equal(parseOptionalCanonicalUuid(null, 'connectionId'), null);
  assert.equal(parseOptionalCanonicalUuid(undefined, 'connectionId'), null);
  assert.equal(
    parseOptionalCanonicalUuid('00000000-0000-0000-0000-000000000101', 'connectionId'),
    '00000000-0000-0000-0000-000000000101',
  );
  assert.throws(
    () => parseOptionalCanonicalUuid('bad', 'connectionId'),
    /Invalid field: connectionId/,
  );
});
