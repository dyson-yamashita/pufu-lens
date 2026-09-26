import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import { buildWorker } from '../build.mjs';

let runtime;
let bundle;
before(async () => {
  bundle = await buildWorker();
  runtime = new Miniflare({
    modules: true,
    script: bundle.script,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: [],
    // No credentials, bindings, remote resources, or outbound service access.
    outboundService: () => new Response('Outbound access disabled', { status: 403 }),
  });
  await runtime.ready;
});
after(async () => runtime?.dispose());

function candidate(documentId, rank, chunkId = `${documentId}-chunk`) {
  return {
    canonicalUri: `https://fixture.invalid/${documentId}`,
    chunkId,
    chunkIndex: 0,
    documentId,
    docType: 'web',
    rank,
    rawDocumentId: `${documentId}-raw`,
    title: `合成資料 ${documentId}`,
    snippet: '形態素とCloudflareの合成fixture',
    providerScore: 999,
  };
}

function fixture() {
  return {
    project: { projectId: 'synthetic-project-a', projectSlug: 'workers-spike' },
    keywordCandidates: [candidate('doc-b', 1), candidate('doc-a', 2), candidate('doc-a', 4)],
    semanticCandidates: [
      { ...candidate('doc-a', 1, 'semantic-a'), cosineDistance: 0.2 },
      { ...candidate('doc-b', 2), cosineDistance: 0.3 },
    ],
    graphCandidates: [
      { documentId: 'doc-b', hopCount: 2, relationType: 'MENTIONS', seedDocumentId: 'doc-a' },
    ],
    graph: {
      nodes: [
        { id: 'doc-a', label: 'Document', labels: ['Document'], properties: { title: '合成' } },
        { id: 'doc-b', label: 'Document', labels: ['Document'], properties: {} },
      ],
      edges: [
        { id: 'edge-ab', label: 'RELATED_TO', source: 'doc-a', target: 'doc-b', properties: {} },
      ],
      preview: 'synthetic graph',
      rawRows: [],
      rowCount: 1,
      truncated: false,
    },
  };
}

async function probe(payload) {
  return runtime.dispatchFetch('http://local.test/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('browser bundle includes all three public Core packages without Node/provider dependencies', () => {
  const paths = Object.keys(bundle.metafile.inputs);
  for (const name of ['graph', 'retrieval', 'project-tenancy']) {
    assert.ok(
      paths.some((path) => path.includes(`/${name}/dist/`)),
      name,
    );
  }
  for (const output of Object.values(bundle.metafile.outputs)) {
    assert.deepEqual(output.imports, []);
  }
  console.log(
    `bundle bytes=${Buffer.byteLength(bundle.script)}, gzip=${gzipSync(bundle.script).length}`,
  );
});

test('workerd executes deterministic RRF, document dedupe, provenance and Graph guards', async () => {
  const response = await probe(fixture());
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(
    result.candidates.map((entry) => entry.documentId),
    ['doc-a', 'doc-b'],
  );
  assert.equal(result.candidates[0].fusedScore, 1 / 61 + 1 / 62);
  assert.equal(result.candidates[0].chunkId, 'semantic-a');
  assert.equal(result.candidates[1].chunkId, 'doc-b-chunk');
  assert.equal(result.candidates[0].cosineDistance, 0.2);
  assert.ok(result.candidates.every((entry) => !('providerScore' in entry)));
  assert.deepEqual(result.graph, fixture().graph);
  assert.deepEqual(result.graphCandidates, fixture().graphCandidates);
  assert.deepEqual(result.project, fixture().project);
});

test('workerd preserves successful empty results', async () => {
  const payload = fixture();
  payload.keywordCandidates = [];
  payload.semanticCandidates = [];
  payload.graphCandidates = [];
  payload.graph = { ...payload.graph, nodes: [], edges: [], rowCount: 0 };
  const response = await probe(payload);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.candidates, []);
  assert.equal(result.graph.rowCount, 0);
});

const invalidCases = [
  [
    'zero rank',
    (p) => {
      p.keywordCandidates[0].rank = 0;
    },
  ],
  [
    'blank identity',
    (p) => {
      p.keywordCandidates[0].documentId = ' ';
    },
  ],
  [
    'invalid snippet',
    (p) => {
      p.keywordCandidates[0].snippet = {};
    },
  ],
  [
    'negative distance',
    (p) => {
      p.semanticCandidates[0].cosineDistance = -1;
    },
  ],
  [
    'null distance',
    (p) => {
      p.semanticCandidates[0].cosineDistance = null;
    },
  ],
  [
    'invalid hop',
    (p) => {
      p.graphCandidates[0].hopCount = 3;
    },
  ],
  [
    'invalid relation',
    (p) => {
      p.graphCandidates[0].relationType = 'UNTRUSTED';
    },
  ],
  [
    'invalid graph count',
    (p) => {
      p.graph.rowCount = '1';
    },
  ],
  [
    'invalid graph node',
    (p) => {
      p.graph.nodes[0].labels = [1];
    },
  ],
  [
    'invalid graph edge',
    (p) => {
      p.graph.edges[0].source = '';
    },
  ],
  [
    'provider project field',
    (p) => {
      p.project.graphName = 'graph_a';
    },
  ],
  [
    'invalid slug',
    (p) => {
      p.project.projectSlug = '../other-project';
    },
  ],
  [
    'invalid array',
    (p) => {
      p.keywordCandidates = {};
    },
  ],
];
for (const [name, mutate] of invalidCases) {
  test(`workerd rejects ${name} at the Core boundary`, async () => {
    const payload = fixture();
    mutate(payload);
    const response = await probe(payload);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid synthetic contract payload' });
  });
}

test('probe rejects malformed JSON and unrelated routes', async () => {
  const response = await runtime.dispatchFetch('http://local.test/probe', {
    method: 'POST',
    body: '{',
  });
  assert.equal(response.status, 400);
  assert.equal((await runtime.dispatchFetch('http://local.test/')).status, 404);
});
