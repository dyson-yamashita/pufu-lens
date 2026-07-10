import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./source-sync-dispatcher.ts', import.meta.url), 'utf8');

test('dispatcher claim uses due checks and skip-locked lease acquisition', () => {
  assert.match(source, /schedule\.next_run_at <= now\(\)/);
  assert.match(source, /FOR UPDATE OF schedule SKIP LOCKED/);
  assert.match(source, /schedule\.enabled = true/);
  assert.match(source, /source\.enabled = true/);
  assert.match(source, /source\.source_type IN \('drive', 'github', 'gmail'\)/);
});

test('heartbeat and completion use worker-token compare-and-set', () => {
  assert.match(source, /worker_token = \$\{workerToken\}/);
  assert.match(source, /lease_expires_at > now\(\)/);
  assert.match(source, /last_started_at \+ \$\{MAX_LEASE_MINUTES\}/);
});

test('retry sequence is 15 minutes, one hour, six hours, then daily', () => {
  assert.match(source, /WHEN 0 THEN now\(\) \+ interval '15 minutes'/);
  assert.match(source, /WHEN 1 THEN now\(\) \+ interval '1 hour'/);
  assert.match(source, /WHEN 2 THEN now\(\) \+ interval '6 hours'/);
  assert.match(source, /retry_count >= 3 THEN 0/);
});

test('process runner targets one data source and runs collect before ingest', () => {
  const collect = source.indexOf("runScript('collect'");
  const ingest = source.indexOf("runScript('ingest'");
  assert.ok(collect >= 0 && ingest > collect);
  assert.equal(source.match(/'--data-source-id'/g)?.length, 2);
  assert.equal(source.match(/target\.dataSourceId/g)?.length, 2);
});
