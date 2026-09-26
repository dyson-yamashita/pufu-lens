import assert from 'node:assert/strict';
import test from 'node:test';
import { corpusHash, type KeywordRun } from './keyword-eval.ts';
import { keywordCorpus } from './keyword-eval-corpus.ts';
import { evaluateParity, parseParityRun } from './parity-eval.ts';
import { localKeywordSnapshot } from './parity-runner.ts';

const commit = 'a'.repeat(40);
const observation = { id: 'japanese', status: 'ok' as const, chunkIds: [], latencyMs: [1] };
const measured: KeywordRun = {
  schemaVersion: 1,
  corpusHash,
  provider: 'pgroonga',
  environment: 'local',
  cases: keywordCorpus.cases.map(({ id }) => ({ ...observation, id })),
};

test('unconfigured backend stays missing; null observations never pass quality', () => {
  const candidate = localKeywordSnapshot('cloudflare', commit, 'test', null);
  const baseline = localKeywordSnapshot('gcp', commit, 'test', null);
  assert.equal(candidate.evidence.missing.length, 52);
  assert.deepEqual(candidate.snapshot.rows, []);
  const report = evaluateParity(candidate.snapshot, baseline.snapshot);
  assert.equal(report.qualityGate, false);
  assert.equal(report.comparisonComplete, false);
  assert.equal(report.contractPass, false);
});

test('fresh results are preserved without filling oracle ranks or absent observations', () => {
  const result = localKeywordSnapshot('gcp', commit, 'test', measured);
  assert.ok(result.snapshot.rows[0]);
  assert.deepEqual(result.snapshot.rows[0].chunkIds, []);
  assert.equal(result.snapshot.rows[0].mutationPass, null);
  assert.equal(result.snapshot.rows[0].rubricPass, null);
  assert.equal(result.evidence.missing.length, 30);
  assert.throws(() =>
    parseParityRun({
      ...result.snapshot,
      rows: [{ ...result.snapshot.rows[0], mutationPass: undefined }],
    }),
  );
});

test('unknown results and case IDs fail closed', () => {
  assert.throws(() =>
    localKeywordSnapshot('gcp', commit, 'test', { ...measured, corpusHash: 'bad' }),
  );
  assert.throws(() =>
    localKeywordSnapshot('gcp', commit, 'test', {
      ...measured,
      cases: measured.cases.map((row, index) => (index === 0 ? { ...row, id: 'unknown' } : row)),
    }),
  );
  assert.throws(() =>
    localKeywordSnapshot('gcp', commit, 'test', {
      ...measured,
      cases: measured.cases.map((row, index) =>
        index === 0 ? { ...row, chunkIds: ['unknown'] } : row,
      ),
    }),
  );
});
