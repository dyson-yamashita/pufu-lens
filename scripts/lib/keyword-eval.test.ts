import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  corpusHash,
  evaluateKeywordRun,
  type KeywordRun,
  parseKeywordRun,
  rankMetrics,
} from './keyword-eval.ts';
import { type KeywordEvalCase, keywordCorpus } from './keyword-eval-corpus.ts';
import { collectPgroongaBaseline } from './keyword-eval-pgroonga.ts';

function idealRun(): KeywordRun {
  return {
    schemaVersion: 1,
    corpusHash,
    provider: 'test-oracle',
    environment: 'hermetic-test-only',
    cases: keywordCorpus.cases.map((row: KeywordEvalCase) => ({
      id: row.id,
      status: row.reject ? 'rejected' : 'ok',
      latencyMs: [1, 2, 3],
      chunkIds: Object.entries(row.grades)
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => {
          const chunk = keywordCorpus.chunks.find((chunk) => chunk.documentId === id);
          assert.ok(chunk);
          return chunk.id;
        }),
    })),
  };
}

test('fixed synthetic corpus has valid scoped graded judgments and a meaningful top-20 pool', () => {
  assert.equal(
    new Set(keywordCorpus.chunks.map((row) => row.id)).size,
    keywordCorpus.chunks.length,
  );
  assert.equal(new Set(keywordCorpus.cases.map((row) => row.id)).size, keywordCorpus.cases.length);
  assert.ok(
    new Set(
      keywordCorpus.chunks.filter((row) => row.projectId === 'alpha').map((row) => row.documentId),
    ).size > 20,
  );
  for (const row of keywordCorpus.cases as readonly KeywordEvalCase[]) {
    for (const [id, grade] of Object.entries(row.grades)) {
      assert.ok(Number.isInteger(grade) && grade > 0 && grade <= 3);
      assert.ok(
        keywordCorpus.chunks.some(
          (chunk) => chunk.documentId === id && chunk.projectId === row.projectId,
        ),
      );
    }
    assert.ok((row.required ?? []).every((id) => (row.grades[id] ?? 0) > 0));
    assert.equal(row.reject === true, row.query.length > keywordCorpus.maxQueryLength);
  }
});

test('metrics use judged recall, first relevant rank and exponential graded DCG', () => {
  const result = rankMetrics(['noise', 'b', 'a'], { a: 3, b: 1 }, 2);
  assert.equal(result.recall, 0.5);
  assert.equal(result.mrr, 0.5);
  assert.equal(result.ndcg, 1 / Math.log2(3) / (7 + 1 / Math.log2(3)));
  assert.deepEqual(rankMetrics([], { a: 3 }), { recall: 0, mrr: 0, ndcg: 0 });
  assert.deepEqual(rankMetrics([], {}), { recall: null, mrr: null, ndcg: null });
  assert.equal(rankMetrics(['a', 'a'], { a: 3, b: 1 }).recall, 0.5);
  assert.equal(
    rankMetrics([...Array.from({ length: 20 }, (_, i) => `n${i}`), 'a'], { a: 3 }).recall,
    0,
  );
});

test('ideal rankings pass; misses, injection results, isolation leaks, rejection and dedupe regressions fail', () => {
  const ideal = idealRun();
  const baseline = { ...ideal, provider: 'pgroonga' };
  const report = evaluateKeywordRun(ideal, baseline);
  assert.equal(report.gate, true);
  assert.equal(report.recall, 1);
  assert.equal(report.mrrDelta, 0);
  assert.ok(report.cases.every((row) => row.overlap === 1));
  assert.equal(report.p50Ms, 2);
  assert.equal(report.p95Ms, 3);
  for (const [id, chunkIds] of [
    ['issue', []],
    ['typo', []],
    ['sql-injection', ['c01']],
    ['isolation', ['c13']],
    ['japanese', ['c01', 'c12', 'c02']],
  ] as const) {
    const broken = {
      ...ideal,
      cases: ideal.cases.map((row) => (row.id === id ? { ...row, chunkIds } : row)),
    };
    assert.equal(evaluateKeywordRun(broken, baseline).gate, false, id);
  }
  const rejected = {
    ...ideal,
    cases: ideal.cases.map((row) =>
      row.id === 'over-length' ? { ...row, status: 'ok' as const } : row,
    ),
  };
  assert.equal(evaluateKeywordRun(rejected).gate, false);
});

test('MRR degradation fails even when recall is unchanged', () => {
  const baseline = { ...idealRun(), provider: 'pgroonga' };
  const slow = {
    ...baseline,
    provider: 'candidate',
    cases: baseline.cases.map((row) =>
      row.chunkIds.length ? { ...row, chunkIds: ['noise-00', ...row.chunkIds] } : row,
    ),
  };
  const result = evaluateKeywordRun(slow, baseline);
  assert.equal(result.recall, 1);
  assert.equal(result.mrrDelta, -0.5);
  assert.equal(result.gate, false);
});

test('malformed or incomplete snapshots cannot silently inflate results', () => {
  const run = idealRun();
  for (const invalid of [
    { ...run, corpusHash: 'stale' },
    { ...run, cases: [] },
    { ...run, cases: run.cases.map(() => run.cases[0]) },
    { ...run, cases: run.cases.map((row) => ({ ...row, chunkIds: ['unknown'] })) },
    { ...run, cases: run.cases.map((row) => ({ ...row, latencyMs: [-1] })) },
    { ...run, cases: run.cases.map((row) => ({ ...row, chunkIds: ['c01', 'c01'] })) },
  ])
    assert.throws(() => parseKeywordRun(invalid));
  assert.throws(() => evaluateKeywordRun(run, run), /PGroonga/);
});

test('recorded PGroonga evidence stays compatible and exposes known quality gaps offline', async () => {
  const baseline = parseKeywordRun(
    JSON.parse(
      await readFile(
        new URL('../../fixtures/keyword/pgroonga-baseline-v1.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const report = evaluateKeywordRun(baseline);
  assert.equal(report.gate, false);
  assert.equal(report.cases.find((row) => row.id === 'typo')?.recall, 0);
  assert.equal(report.cases.find((row) => row.id === 'query-injection')?.hardPass, false);
  assert.equal(report.cases.find((row) => row.id === 'isolation')?.hardPass, true);
});

test('collector refuses remote targets before connecting', async () => {
  await assert.rejects(
    collectPgroongaBaseline('postgres://localhost/fixture?host=remote'),
    /loopback/,
  );
  await assert.rejects(collectPgroongaBaseline('postgres://example.invalid/fixture'), /loopback/);
});

test('offline CLI writes deterministic JSON / Markdown, returns nonzero for failed gates and omits text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keyword-eval-'));
  try {
    const input = join(directory, 'input.json');
    const output = join(directory, 'report.json');
    const markdown = join(directory, 'report.md');
    await writeFile(input, JSON.stringify(idealRun()));
    const args = [
      '--experimental-strip-types',
      'scripts/keyword-eval.ts',
      'evaluate',
      '--input',
      input,
      '--output',
      output,
      '--markdown',
      markdown,
    ];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const report = await readFile(output, 'utf8');
    assert.equal(spawnSync(process.execPath, args).status, 0);
    assert.equal(await readFile(output, 'utf8'), report);
    assert.doesNotMatch(report, /仕様変更|"snippet"|"content"|"query"/);
    assert.match(await readFile(markdown, 'utf8'), /PASS/);
    await writeFile(
      input,
      JSON.stringify({
        ...idealRun(),
        cases: idealRun().cases.map((row) => ({ ...row, chunkIds: [] })),
      }),
    );
    assert.equal(spawnSync(process.execPath, args).status, 1);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).gate, false);
  } finally {
    await rm(directory, { recursive: true });
  }
});
