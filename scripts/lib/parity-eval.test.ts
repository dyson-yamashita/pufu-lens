import assert from 'node:assert/strict';
import test from 'node:test';
import { rankMetrics } from './keyword-eval.ts';
import {
  evaluateParity,
  graphSetMatches,
  type ParityRun,
  parityOverlap,
  parseParityRun,
} from './parity-eval.ts';
import { parityFixture, parityFixtureHash, parityMappingHash } from './parity-fixture.ts';

// Oracle-only snapshots exercise scoring; they are not backend observations.
function oracle(profile: 'gcp' | 'cloudflare' = 'cloudflare'): ParityRun {
  return {
    metadata: {
      runId: `oracle-${profile}`,
      codeCommit: 'a'.repeat(40),
      profile,
      region: 'local-test',
      fixtureVersion: parityFixture.version,
      fixtureHash: parityFixtureHash,
      schemaVersion: 1,
      mappingHash: parityMappingHash,
      embedding: { ...parityFixture.embedding },
    },
    rows: parityFixture.cases.map((row) => {
      const ids = Object.keys(row.grades).sort(
        (a, b) => (row.grades[b] ?? 0) - (row.grades[a] ?? 0),
      );
      return {
        id: row.id,
        status: row.expectedFailure ? 'error' : 'ok',
        error: row.expectedFailure,
        chunkIds: ids.map(
          (id) => parityFixture.chunks.find((chunk) => chunk.documentId === id)?.id ?? '',
        ),
        finalDocumentIds: ids,
        citationDocumentIds: ids,
        tools: [...row.requiredTools],
        graph: row.graph.map((tuple) => [...tuple]),
        scopePass: true,
        mutationPass: true,
        rubricPass: true,
        criticalErrors: 0,
      };
    }),
  };
}
function row(run: ParityRun, id: string) {
  const result = run.rows.find((row) => row.id === id);
  assert.ok(result);
  return result;
}

test('explicit unknown observations cannot pass even with complete oracle ranks', () => {
  for (const profile of ['gcp', 'cloudflare'] as const) {
    for (const field of ['scopePass', 'mutationPass', 'rubricPass'] as const) {
      const candidate = oracle();
      const baseline = oracle('gcp');
      row(profile === 'gcp' ? baseline : candidate, 'chat-design')[field] = null;
      assert.equal(evaluateParity(candidate, baseline).qualityGate, false);
    }
  }
});

test('hand-calculated graded ranking and truncated recall/MRR', () => {
  const metrics = rankMetrics(['noise', 'b', 'a', 'a'], { a: 3, b: 1, c: 2 }, 3);
  assert.equal(metrics.recall, 2 / 3);
  assert.equal(metrics.mrr, 1 / 2);
  assert.equal(metrics.ndcg, (1 / Math.log2(3) + 7 / 2) / (7 + 3 / Math.log2(3) + 1 / 2));
  assert.deepEqual(rankMetrics(['noise', 'a'], { a: 3 }, 1), { recall: 0, mrr: 0, ndcg: 0 });
  assert.deepEqual(rankMetrics([], {}), { recall: null, mrr: null, ndcg: null });
});

test('overlap dedupes before truncation, uses actual set size, and has no empty evidence', () => {
  assert.equal(parityOverlap(['a', 'b', 'c', 'd', 'x'], ['a', 'b', 'c', 'd', 'e'], 5), 0.8);
  assert.equal(parityOverlap(['a', 'a', 'b'], ['b', 'a'], 2), 1);
  assert.equal(parityOverlap(['a'], ['a', 'b'], 10), 0.5);
  assert.equal(parityOverlap([], ['a'], 10), 0);
  assert.equal(parityOverlap([], [], 10), null);
});

test('complete oracle can pass quality only, and JSON report contains no content/query', () => {
  const report = evaluateParity(oracle(), oracle('gcp'));
  assert.equal(report.qualityGate, true);
  assert.equal(report.step7Gate, 'not-evaluated');
  const serialized = JSON.stringify(report);
  assert.deepEqual(JSON.parse(serialized), report);
  for (const chunk of parityFixture.chunks) assert.ok(!serialized.includes(chunk.content));
  assert.ok(!serialized.includes('"query":'));
});

test('missing baseline, missing row and empty snapshots never pass', () => {
  assert.equal(evaluateParity(oracle()).qualityGate, false);
  for (const profile of ['gcp', 'cloudflare'] as const) {
    const candidate = oracle();
    const baseline = oracle('gcp');
    (profile === 'gcp' ? baseline : candidate).rows.pop();
    const report = evaluateParity(candidate, baseline);
    assert.equal(report.comparisonComplete, false);
    assert.equal(report.qualityGate, false);
  }
  const empty = oracle();
  empty.rows = [];
  assert.equal(evaluateParity(empty, oracle('gcp')).qualityGate, false);
});

test('contract mismatch and synthetic embeddings fail closed on either side', () => {
  const mutations: ((run: ParityRun) => void)[] = [
    (run) => {
      run.metadata.fixtureVersion = 'v2';
    },
    (run) => {
      run.metadata.fixtureHash = 'wrong';
    },
    (run) => {
      run.metadata.schemaVersion = 2;
    },
    (run) => {
      run.metadata.mappingHash = 'wrong';
    },
    (run) => {
      run.metadata.embedding.mode = 'synthetic';
    },
    (run) => {
      run.metadata.embedding.model = 'other';
    },
    (run) => {
      run.metadata.embedding.dimensions = 3;
    },
    (run) => {
      run.metadata.embedding.metric = 'euclidean';
    },
  ];
  for (const mutate of mutations)
    for (const side of ['candidate', 'baseline']) {
      const candidate = oracle();
      const baseline = oracle('gcp');
      mutate(side === 'candidate' ? candidate : baseline);
      assert.equal(evaluateParity(candidate, baseline).contractPass, false);
    }
  assert.equal(evaluateParity(oracle('gcp'), oracle()).qualityGate, false);
});

test('scope leak in candidates, final sources, citations or Graph is a hard failure', () => {
  for (const field of ['chunkIds', 'finalDocumentIds', 'citationDocumentIds', 'graph'] as const) {
    const run = oracle();
    const result = row(run, 'chat-design');
    if (field === 'graph') result.graph.push(['beta', 'd13', 'NODE', 'd13', 0]);
    else result[field].push(field === 'chunkIds' ? 'c13' : 'd13');
    assert.equal(evaluateParity(run, oracle('gcp')).qualityGate, false);
  }
  const baseline = oracle('gcp');
  row(baseline, 'keyword-issue').scopePass = false;
  assert.equal(evaluateParity(oracle(), baseline).qualityGate, false);
  const spoofed = oracle();
  row(spoofed, 'chat-design').graph.push(['alpha', 'd13', 'NODE', 'd13', 0]);
  assert.equal(evaluateParity(spoofed, oracle('gcp')).qualityGate, false);
});

test('required exact source, hybrid final selection, Chat citation/tool/rubric cannot be averaged away', () => {
  const mutations: ((run: ParityRun) => void)[] = [
    (run) => {
      row(run, 'keyword-issue').chunkIds = [];
    },
    (run) => {
      row(run, 'hybrid-design').finalDocumentIds = [];
    },
    (run) => {
      row(run, 'chat-design').citationDocumentIds = [];
    },
    (run) => {
      row(run, 'chat-design').tools = [];
    },
    (run) => {
      row(run, 'chat-design').rubricPass = false;
    },
    (run) => {
      row(run, 'chat-design').criticalErrors = 1;
    },
    (run) => {
      row(run, 'mutation-merge').mutationPass = false;
    },
    (run) => {
      row(run, 'keyword-empty').chunkIds = ['c01'];
    },
  ];
  for (const mutate of mutations) {
    const run = oracle();
    mutate(run);
    assert.equal(evaluateParity(run, oracle('gcp')).qualityGate, false);
  }
});

test('expected failures require exact normalized failure and no returned data', () => {
  const run = oracle();
  row(run, 'failure-timeout').error = 'overloaded';
  assert.equal(evaluateParity(run, oracle('gcp')).qualityGate, false);
  row(run, 'failure-timeout').error = 'timeout';
  row(run, 'failure-timeout').chunkIds = ['c01'];
  assert.equal(evaluateParity(run, oracle('gcp')).qualityGate, false);
});

test('Graph ignores order only; relation, hop, extra/missing nodes and duplicates fail', () => {
  const expected = [
    ['alpha', 'd01', 'RELATED_TO', 'd02', 1],
    ['alpha', 'd01', 'NODE', 'd01', 0],
  ] as const;
  const reordered: ParityRun['rows'][number]['graph'] = expected.map((tuple) => [...tuple]);
  assert.equal(graphSetMatches(reordered.reverse(), expected), true);
  assert.equal(graphSetMatches([], expected), false);
  for (const graph of [
    [['alpha', 'd01', 'RELATED_TO', 'd02', 2]],
    [['alpha', 'd01', 'MENTIONS', 'd02', 1]],
    [
      ['alpha', 'd01', 'RELATED_TO', 'd02', 1],
      ['alpha', 'd01', 'RELATED_TO', 'd02', 1],
    ],
  ] satisfies ParityRun['rows'][number]['graph'][]) {
    const run = oracle();
    row(run, 'graph-RELATED_TO').graph = graph;
    assert.equal(evaluateParity(run, oracle('gcp')).qualityGate, false);
  }
});

test('poor ranking fails fixed semantic and keyword tolerances', () => {
  for (const kind of ['semantic', 'keyword', 'hybrid']) {
    const run = oracle();
    for (const result of run.rows.filter((row) => row.id.startsWith(`${kind}-`))) {
      result.chunkIds = ['noise-00', 'noise-01', 'noise-02', ...result.chunkIds];
    }
    assert.equal(
      evaluateParity(run, oracle('gcp')).aggregates.find((row) => row.kind === kind)?.pass,
      false,
    );
  }
});

test('hybrid overlap accepts 0.80 boundary and rejects below it without changing relevance', () => {
  const candidate = oracle();
  const baseline = oracle('gcp');
  for (const reference of baseline.rows.filter((row) => row.id.startsWith('hybrid-'))) {
    reference.chunkIds = [
      ...reference.chunkIds,
      'noise-00',
      'noise-01',
      'noise-02',
      'noise-03',
    ].slice(0, 5);
    row(candidate, reference.id).chunkIds = [...reference.chunkIds.slice(0, 4), 'noise-23'];
  }
  assert.equal(evaluateParity(candidate, baseline).qualityGate, true);
  for (const result of candidate.rows.filter((row) => row.id.startsWith('hybrid-')))
    result.chunkIds[3] = 'noise-22';
  assert.equal(evaluateParity(candidate, baseline).qualityGate, false);
});

test('required exact document outside Top-20 is a hard failure even when present in the snapshot', () => {
  const candidate = oracle();
  row(candidate, 'keyword-issue').chunkIds = [
    ...Array.from({ length: 20 }, (_, index) => `noise-${String(index).padStart(2, '0')}`),
    'c05',
  ];
  assert.equal(
    evaluateParity(candidate, oracle('gcp')).cases.find((row) => row.id === 'keyword-issue')
      ?.hardPass,
    false,
  );
  for (const k of [0, -1, 1.5, Number.NaN]) assert.throws(() => parityOverlap([], [], k));
});

test('invalid snapshot shapes, unknown/duplicate IDs and absent observations are rejected', () => {
  for (const mutate of [
    (run: ParityRun) => {
      run.rows.push(row(run, 'keyword-issue'));
    },
    (run: ParityRun) => {
      row(run, 'semantic-design').chunkIds = ['unknown'];
    },
    (run: ParityRun) => {
      row(run, 'semantic-design').chunkIds = ['c01', 'c01'];
    },
    (run: ParityRun) => {
      row(run, 'semantic-design').criticalErrors = Number.NaN;
    },
    (run: ParityRun) => {
      row(run, 'semantic-design').error = 'timeout';
    },
  ]) {
    const run = oracle();
    mutate(run);
    assert.throws(() => parseParityRun(run));
  }
  const run = oracle();
  assert.throws(() => parseParityRun({ ...run, rows: [{ ...run.rows[0], scopePass: undefined }] }));
  assert.throws(() => parseParityRun(null));
});

test('fixture judgments map to scoped documents/chunks and cover all nine mutation relations', () => {
  assert.equal(
    parityFixtureHash,
    'dcc6f43a0ffd264b6e9ce9701e8f23f65f3cb5d826191e77410726a987ae0450',
  );
  assert.equal(
    parityMappingHash,
    '70a243fde0e07f3bf23283dc68b5dd656a8cd67fbb2b38b4a514d624410c2278',
  );
  assert.equal(new Set(parityFixture.cases.map((row) => row.id)).size, parityFixture.cases.length);
  assert.equal(parityFixture.cases.filter((row) => row.id.startsWith('mutation-edge-')).length, 9);
  for (const row of parityFixture.cases)
    for (const [id, grade] of Object.entries(row.grades)) {
      assert.ok(grade > 0 && grade <= 3);
      assert.ok(
        parityFixture.chunks.some(
          (chunk) => chunk.documentId === id && chunk.projectId === row.projectId,
        ),
      );
    }
});
