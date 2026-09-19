import assert from 'node:assert/strict';
import test from 'node:test';
import { parseKeywordBackfillOptions } from './keyword-backfill.ts';

const project = '10000000-0000-0000-0000-000000000001';
test('keyword backfill validates scope, bounds and explicit modes before connecting', () => {
  const args = ['--project', project, '--dry-run'];
  assert.equal(parseKeywordBackfillOptions(args).limit, 100);
  for (const suffix of [
    ['--execute'],
    ['--status'],
    ['--limit', '0'],
    ['--limit', '1001'],
    ['--limit', '1.5'],
    ['--limit', '1e2'],
    ['--resume-cursor', 'invalid'],
    ['--document-from', 'bad'],
    ['--unknown'],
    ['--project', project],
    ['--document-from', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '--document-through', project],
  ])
    assert.throws(() => parseKeywordBackfillOptions([...args, ...suffix]));
  assert.throws(() => parseKeywordBackfillOptions(['--project', project]));
  assert.throws(() => parseKeywordBackfillOptions(['--execute']));
});
