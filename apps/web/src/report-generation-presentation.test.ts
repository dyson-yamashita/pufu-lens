import assert from 'node:assert/strict';
import test from 'node:test';
import { reportGenerationLabel } from './report-generation-presentation.ts';

test('reportGenerationLabel identifies manual reports', () => {
  assert.equal(reportGenerationLabel('manual', null), '手動');
});

test('reportGenerationLabel identifies scheduled cadence and backfill', () => {
  assert.equal(reportGenerationLabel('scheduled', 'weekly'), '定期（週次）');
  assert.equal(reportGenerationLabel('scheduled_backfill', 'annually'), '定期 backfill（年次）');
});
