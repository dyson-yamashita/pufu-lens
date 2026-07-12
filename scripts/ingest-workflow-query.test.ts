import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./ingest-workflow.ts', import.meta.url), 'utf8');

test('parsed raw remaining count excludes superseded source versions', () => {
  const start = source.indexOf('async function countParsedRawRemaining');
  const end = source.indexOf('\nfunction measureStepProgress', start);
  const query = source.slice(start, end);

  assert.match(query, /NOT EXISTS\s*\(\s*SELECT 1\s*FROM public\.raw_documents newer/s);
  assert.match(query, /newer\.logical_source_id = rd\.logical_source_id/);
  assert.match(query, /newer\.ingest_status IN \('parsed', 'indexed'\)/);
  assert.match(query, /\(newer\.created_at, newer\.id\) > \(rd\.created_at, rd\.id\)/);
});
