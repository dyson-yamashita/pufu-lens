import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  collectKeywordQuality,
  qualityCorpusHash,
  qualityMetrics,
  summarizeKeywordQuality,
} from './keyword-quality.ts';
import { qualityCases, qualityDocuments, qualityHybridCases } from './keyword-quality-corpus.ts';

const snapshotUrl = new URL('../../fixtures/keyword/quality-holdout-v2.json', import.meta.url);

test('independent holdout judgments are complete and distinct from provider observations', async () => {
  const snapshot = JSON.parse(await readFile(snapshotUrl, 'utf8'));
  assert.equal(snapshot.corpusHash, qualityCorpusHash);
  assert.equal(qualityCases.length, 56);
  assert.equal(qualityDocuments.length, 33);
  assert.equal(new Set(qualityCases.map((row) => row.id)).size, qualityCases.length);
  const documentIds = new Set<string>(qualityDocuments.map(([id]) => id));
  for (const row of qualityCases) {
    assert.equal(new Set(row.relevant).size, row.relevant.length);
    assert.ok(row.relevant.every((id) => documentIds.has(id)));
  }
  for (const row of qualityHybridCases) {
    assert.ok(qualityCases.some((query) => query.id === row.queryId));
    assert.ok([...row.semantic, ...row.required].every((id) => documentIds.has(id)));
  }
  assert.equal(snapshot.keywordExactGate, false, 'Recorded failures must not become acceptance');
  assert.equal(snapshot.hybridGate, false);
});

test('quality metrics preserve misses, false positives, rank loss, and negative cases', () => {
  assert.deepEqual(qualityMetrics(['a'], []), {
    missing: ['a'],
    extra: [],
    recall: 0,
    mrr: 0,
    ndcg: 0,
    exact: false,
  });
  assert.deepEqual(qualityMetrics([], ['b']), {
    missing: [],
    extra: ['b'],
    recall: null,
    mrr: null,
    ndcg: null,
    exact: false,
  });
  const ranked = qualityMetrics(['a'], ['b', 'a']);
  assert.equal(ranked.recall, 1);
  assert.equal(ranked.mrr, 0.5);
  assert.equal(ranked.ndcg, 1 / Math.log2(3));
  assert.equal(ranked.exact, false);
  const rows = [
    { provider: 'portable-primary', category: 'positive', ...qualityMetrics(['a'], []) },
    { provider: 'portable-primary', category: 'negative', ...qualityMetrics([], ['b']) },
  ];
  const summary = summarizeKeywordQuality(rows)[1];
  assert.equal(summary?.recall, 0);
  assert.equal(summary?.negativeFailures, 1);
  assert.equal(summary?.exactFailures, 2);
});

test('live keyword, hybrid selection and loopback workflow HTTP reproduce documented residuals', {
  skip: !process.env.KEYWORD_EVAL_DATABASE_URL,
}, async () => {
  const url = process.env.KEYWORD_EVAL_DATABASE_URL;
  assert.ok(url);
  const report = await collectKeywordQuality(url);
  const snapshot = JSON.parse(await readFile(snapshotUrl, 'utf8'));
  // Freeze missing/extra evidence, not arbitrary provider raw scores or exact tied ranks.
  const residuals = (rows: typeof report.keyword) =>
    rows.map(({ provider, id, missing, extra }) => ({
      provider,
      id,
      missing: [...missing].sort(),
      extra: [...extra].sort(),
    }));
  assert.deepEqual(residuals(report.keyword), residuals(snapshot.keyword));
  assert.equal(report.keywordExactGate, false);
  assert.equal(report.hybridGate, false);
  assert.deepEqual(report.comparisons, snapshot.comparisons);
  const selections = (rows: typeof report.hybrid) =>
    rows.map(({ provider, id, requiredMissing, finalMissing, final, toolCalls }) => ({
      provider,
      id,
      requiredMissing,
      finalMissing,
      final: [...final].sort(),
      toolCalls,
    }));
  assert.deepEqual(selections(report.hybrid), selections(snapshot.hybrid));
  assert.equal(report.http.protocolRoundTrips, 16);
});
