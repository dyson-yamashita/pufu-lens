import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./report-schedule-dispatcher.ts', import.meta.url), 'utf8');

test('report schedule dispatcher materialize uses due checks and skip-locked lease acquisition', () => {
  assert.match(source, /schedule\.next_run_at <= now\(\)/);
  assert.match(source, /FOR UPDATE OF schedule SKIP LOCKED/);
  assert.match(source, /schedule\.frequency <> 'none'/);
  assert.match(
    source,
    /ON CONFLICT \(project_id, frequency, period_start, period_end\) DO NOTHING/,
  );
});

test('report schedule claim uses oldest incomplete priority and skip-locked lease acquisition', () => {
  assert.match(source, /FOR UPDATE OF period_run SKIP LOCKED/);
  assert.match(source, /older\.status NOT IN \('succeeded', 'skipped'\)/);
  assert.match(source, /ORDER BY period_run\.period_start, period_run\.period_end, period_run\.id/);
});

test('heartbeat and completion use worker-token compare-and-set', () => {
  assert.match(source, /worker_token = \$\{workerToken\}/);
  assert.match(source, /lease_expires_at > now\(\)/);
  assert.match(source, /started_at \+ \$\{MAX_LEASE_MINUTES\}/);
});

test('period run retry sequence is 15 minutes, one hour, six hours, then retry exhausted', () => {
  assert.match(source, /WHEN 0 THEN now\(\) \+ interval '15 minutes'/);
  assert.match(source, /WHEN 1 THEN now\(\) \+ interval '1 hour'/);
  assert.match(source, /WHEN 2 THEN now\(\) \+ interval '6 hours'/);
  assert.match(source, /attempt_count >= 3 THEN 'retry_exhausted'/);
});

test('runner skips periods without candidate documents before report generation', () => {
  assert.match(source, /listRecentDocuments/);
  assert.match(source, /skipReason: 'no_documents'/);
  assert.match(source, /readPreviousScheduledReportFromSql/);
  assert.match(source, /schedulePeriodRunId: input\.target\.periodRunId/);
});

test('materialize catches up due slots with bounded period enumeration', () => {
  assert.match(source, /enumerateDueMaterializePeriods/);
  assert.match(source, /claimedAt/);
  assert.match(source, /MATERIALIZE_PERIOD_LIMIT/);
  assert.match(source, /enumeration\.hasMore/);
  assert.match(source, /enumeration\.nextRunAt/);
});

test('materialize schedule lease release uses worker token compare-and-set', () => {
  assert.match(source, /releaseMaterializedScheduleLease/);
  assert.match(source, /schedule\.worker_token = \$\{input\.workerToken\}/);
  assert.match(source, /MaterializeScheduleLeaseLostError/);
});

test('period run completion updates project report schedule summary in the same transaction', () => {
  assert.match(source, /updateScheduleSummaryOnSuccess/);
  assert.match(source, /updateScheduleSummaryOnFailure/);
  assert.match(source, /last_succeeded_at = now\(\)/);
  assert.match(source, /last_failed_at = now\(\)/);
  assert.match(source, /sql\.begin\(async \(tx\)/);
});

test('retry exhausted periods remain in the oldest-incomplete blocker set', () => {
  assert.match(source, /retry_exhausted/);
  assert.doesNotMatch(
    source.slice(
      source.indexOf('older.status NOT IN'),
      source.indexOf('ORDER BY period_run.period_start'),
    ),
    /retry_exhausted/,
  );
});

test('duplicate period materialize is ignored with on-conflict do nothing', () => {
  assert.match(
    source,
    /ON CONFLICT \(project_id, frequency, period_start, period_end\) DO NOTHING/,
  );
});
