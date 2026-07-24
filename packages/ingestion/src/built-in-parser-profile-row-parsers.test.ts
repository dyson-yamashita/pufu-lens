import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBuiltInParserProfileIdRow,
  parseBuiltInParserProfileTargetRow,
} from './built-in-parser-profile-row-parsers.js';

test('parseBuiltInParserProfileTargetRow accepts typed SQL rows', () => {
  assert.deepEqual(
    parseBuiltInParserProfileTargetRow({
      dataSourceId: 'ds-1',
      projectId: 'project-1',
      sourceType: 'github',
    }),
    {
      dataSourceId: 'ds-1',
      projectId: 'project-1',
      sourceType: 'github',
    },
  );
});

test('parseBuiltInParserProfileTargetRow rejects invalid source types', () => {
  assert.throws(
    () =>
      parseBuiltInParserProfileTargetRow({
        dataSourceId: 'ds-1',
        projectId: 'project-1',
        sourceType: 'slack',
      }),
    /sourceType/,
  );
});

test('parseBuiltInParserProfileIdRow requires non-empty id', () => {
  assert.throws(() => parseBuiltInParserProfileIdRow({ id: '' }), /id/);
});
