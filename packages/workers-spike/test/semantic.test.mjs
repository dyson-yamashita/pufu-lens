import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { buildWorker } from '../build.mjs';

let runtime, db;
let vectors, calls, failure, override, description, embeddingReply, afterUpsert;
const values = [1, ...Array(1535).fill(0)];
before(async () => {
  const { script } = await buildWorker('semantic-worker');
  runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: [],
    d1Databases: { DB: 'semantic-local' },
    outboundService: async (request) => {
      const url = new URL(request.url);
      const body = await request.json();
      if (url.hostname !== 'vectorize-fake.invalid') {
        assert.ok(['api.openai.com', 'generativelanguage.googleapis.com'].includes(url.hostname));
        calls.push({ method: 'embedding', body, url: url.href });
        if (embeddingReply) return Response.json(embeddingReply);
        if (url.hostname === 'api.openai.com') {
          assert.equal(body.dimensions, 1536);
          assert.equal(body.model, 'text-embedding-3-small');
          assert.equal(request.headers.get('authorization'), 'Bearer synthetic-not-a-secret');
          return Response.json({
            data: body.input
              .map((text, index) => ({
                index,
                embedding: [Number(text.split('-').at(-1)) + 1, ...values.slice(1)],
              }))
              .reverse(),
          });
        }
        assert.equal(request.headers.get('x-goog-api-key'), 'synthetic-not-a-secret');
        assert.ok(
          body.requests.every(
            (r) => r.outputDimensionality === 1536 && r.model === 'models/gemini-embedding-2',
          ),
        );
        return Response.json({
          embeddings: body.requests.map((r) => ({
            values: [Number(r.content.parts[0].text.split('-').at(-1)) + 1, ...values.slice(1)],
          })),
        });
      }
      const method = url.pathname.slice(1);
      calls.push({ method, body });
      if (failure === method) return new Response(null, { status: 503 });
      if (method === 'describe') return Response.json(description);
      if (method === 'upsert') for (const v of body) vectors.set(v.id, v);
      if (method === 'upsert' && afterUpsert) {
        const callback = afterUpsert;
        afterUpsert = undefined;
        await callback();
      }
      if (method === 'delete') for (const id of body) vectors.delete(id);
      if (method === 'query') {
        const { options } = body;
        assert.equal(options.namespace, options.filter.projectId);
        assert.equal(options.filter.model, 'synthetic-v1');
        assert.equal(options.returnMetadata, 'all');
        assert.equal(options.returnValues, false);
        const matches =
          override ??
          [...vectors.values()]
            .filter(
              (v) =>
                v.namespace === options.namespace &&
                v.metadata.projectId === options.filter.projectId &&
                v.metadata.model === options.filter.model,
            )
            .map((v, i) => ({ ...v, score: 1 - i * 0.1 }))
            .slice(0, options.topK);
        return Response.json({ count: matches.length, matches });
      }
      return Response.json({ mutationId: `mutation-${calls.length}` });
    },
  });
  await runtime.ready;
  db = await runtime.getD1Database('DB');
  for (const file of ['0001_graph.sql', '0003_semantic.sql']) {
    const sql = await readFile(new URL(`../d1/${file}`, import.meta.url), 'utf8');
    await db.batch(
      sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
  await db.prepare("INSERT INTO projects VALUES ('alpha'),('beta')").run();
});
beforeEach(async () => {
  vectors = new Map();
  calls = [];
  failure = override = embeddingReply = afterUpsert = undefined;
  description = { dimensions: 1536, vectorCount: 0 };
  await db.batch(
    ['semantic_outbox', 'semantic_heads', 'semantic_versions'].map((t) =>
      db.prepare(`DELETE FROM ${t}`),
    ),
  );
});
after(async () => runtime?.dispose());
async function call(operation, input, status = 200, config) {
  const response = await runtime.dispatchFetch('http://local.test/semantic', {
    method: 'POST',
    body: JSON.stringify({ operation, input, config }),
  });
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify({ operation, body }));
  return body.result;
}
const key = (revision = 1, projectId = 'alpha', documentId = 'doc') => ({
  projectId,
  documentId,
  revision,
});
const snapshot = (revision = 1, projectId = 'alpha', documentId = 'doc', count = 1) => ({
  ...key(revision, projectId, documentId),
  model: 'synthetic-v1',
  chunks: Array.from({ length: count }, (_, i) => ({
    values,
    candidate: {
      canonicalUri: 'https://synthetic.invalid',
      chunkId: `chunk-${i}`,
      chunkIndex: i,
      documentId,
      docType: 'web_page',
      rawDocumentId: `raw-${revision}`,
      title: `title-${revision}`,
      snippet: `original-${i}`,
    },
  })),
});
const query = (extra = {}) => ({
  projectId: 'alpha',
  embedding: values,
  embeddingModel: 'synthetic-v1',
  limit: 20,
  ...extra,
});
async function seed(s = snapshot()) {
  await call('enqueue', s);
  await call('deliver', s);
}

test('real D1 atomic enqueue, identical retry, conflicting revision rollback, monotonic ordering', async () => {
  await call('enqueue', snapshot(2));
  await call('enqueue', snapshot(2));
  await call('enqueue', snapshot(1));
  const conflict = snapshot(2);
  conflict.chunks[0].candidate.title = 'conflict';
  await call('enqueue', conflict, 503);
  assert.equal((await db.prepare('SELECT revision FROM semantic_heads').first()).revision, 2);
  assert.equal((await call('inspect', key())).length, 2);
  await db
    .prepare(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON semantic_outbox WHEN NEW.revision=3 BEGIN SELECT RAISE(ABORT,'test'); END",
    )
    .run();
  await call('enqueue', snapshot(3), 503);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM semantic_versions').first()).n, 2);
  assert.equal((await db.prepare('SELECT revision FROM semantic_heads').first()).revision, 2);
  await db.prepare('DROP TRIGGER fail_outbox').run();
  await call('enqueue', snapshot(1, 'missing'), 503);
});

test('scope, provenance, cosine direction, pre-dedupe cap and contiguous document rank', async () => {
  await seed(snapshot(1, 'alpha', 'doc', 2));
  await seed(snapshot(1, 'alpha', 'second'));
  await seed(snapshot(1, 'beta', 'doc'));
  const result = await call('search', query({ limit: 2, preDedupLimit: 3 }));
  assert.deepEqual(
    result.map((c) => [c.documentId, c.rank, c.snippet, c.rawDocumentId]),
    [
      ['doc', 1, 'original-0', 'raw-1'],
      ['second', 2, 'original-0', 'raw-1'],
    ],
  );
  assert.equal(result[0].cosineDistance, 0);
  assert.ok(Math.abs(result[1].cosineDistance - 0.2) < 1e-12);
  assert.equal('score' in result[0], false);
  assert.equal('metadata' in result[0], false);
  assert.equal((await call('search', query({ limit: 2, preDedupLimit: 2 }))).length, 1);
  const own = [...vectors.values()].find((v) => v.namespace === 'alpha');
  override = [{ ...own, score: -1 }];
  assert.equal((await call('search', query()))[0].cosineDistance, 2);
  override = [];
  assert.deepEqual(await call('search', query()), []);
  failure = 'query';
  await call('search', query(), 503);
});

test('filter configuration, index dimensions/metric and input budgets fail closed', async () => {
  for (const config of [
    { indexedMetadata: [] },
    { indexedMetadata: ['projectId'] },
    { dimensions: 768 },
    { metric: 'euclidean' },
  ])
    await call('search', query(), 503, config);
  for (const extra of [
    { projectId: '' },
    { embeddingModel: 'other' },
    { embedding: [] },
    { embedding: Array(1536).fill(0) },
    { limit: 51 },
    { limit: 0 },
    { preDedupLimit: 51 },
  ])
    await call('search', query(extra), 503);
  description = { dimensions: 768, metric: 'cosine' };
  await call('search', query(), 503);
  description = { dimensions: 1536, metric: 'euclidean' };
  await call('search', query(), 503);
  assert.equal(
    calls.some((c) => c.method === 'query'),
    false,
  );
});

test('foreign project, malformed score/metadata, missing D1 and corrupted row are unavailable', async () => {
  await seed();
  const original = [...vectors.values()][0];
  for (const change of [
    { namespace: 'beta' },
    { metadata: { ...original.metadata, projectId: 'beta' } },
    { metadata: { ...original.metadata, model: 'wrong' } },
    { metadata: {} },
    { score: 1.1 },
    { score: null },
    { id: 'unknown' },
  ]) {
    override = [{ ...original, score: 0.8, ...change }];
    await call('search', query(), 503);
  }
  override = [
    { ...original, score: 0.8 },
    { ...original, score: 0.8 },
  ];
  await call('search', query(), 503);
  override = undefined;
  await db
    .prepare(
      "UPDATE semantic_versions SET payload=json_set(payload,'$.chunks[0].candidate.chunkIndex',-1)",
    )
    .run();
  await call('search', query(), 503);
});

test('duplicates and concurrent delivery use immutable IDs; reversed revision delivery cannot overwrite head', async () => {
  await call('enqueue', snapshot());
  await Promise.all([call('deliver', key()), call('deliver', key())]);
  assert.equal(vectors.size, 1);
  assert.equal(await call('deliver', key()), 'skipped');
  const old = [...vectors.values()][0];
  await call('enqueue', snapshot(2));
  await call('deliver', key(2));
  await call('deliver', key(1));
  assert.equal(vectors.size, 1);
  assert.equal([...vectors.values()][0].metadata.revision, 2);
  vectors.set(old.id, old); // Simulate late visibility of an already accepted old upsert.
  await call('search', query(), 503);
  await call('repair', key(1));
  await call('deliver', key(1));
  assert.equal((await call('search', query()))[0].rawDocumentId, 'raw-2');
});

test('tombstone removes old vectors through durable intents; newer reindex survives old deletes', async () => {
  await seed();
  await call('enqueue', snapshot(2, 'alpha', 'doc', 0));
  await call('search', query(), 503);
  await call('deliver', key(2));
  await call('deliver', key(1));
  assert.equal(vectors.size, 0);
  assert.deepEqual(await call('search', query()), []);
  await seed(snapshot(3));
  await call('repair', key(1));
  await call('deliver', key(1));
  assert.equal(vectors.size, 1);
  assert.equal((await call('search', query()))[0].rawDocumentId, 'raw-3');
});

test('late acknowledgement cannot swallow repair or a newer revision cleanup intent', async () => {
  await call('enqueue', snapshot());
  afterUpsert = () => call('enqueue', snapshot(2));
  await call('deliver', key(1));
  assert.equal((await call('inspect', key()))[0].state, 'pending');
  await call('deliver', key(1));
  afterUpsert = () => call('repair', key(2));
  await call('deliver', key(2));
  assert.equal((await call('inspect', key()))[1].state, 'pending');
  await call('deliver', key(2));
  assert.equal(vectors.size, 1);
  assert.equal((await call('search', query()))[0].rawDocumentId, 'raw-2');
});

test('durable retry/backoff, dead-letter repair and accepted-but-lost reindex', async () => {
  await call('enqueue', snapshot());
  failure = 'upsert';
  assert.equal(await call('deliver', { ...key(), now: 0 }), 'retry');
  assert.equal(await call('deliver', { ...key(), now: 999 }), 'skipped');
  assert.equal(await call('deliver', { ...key(), now: 1000 }), 'retry');
  assert.equal(await call('deliver', { ...key(), now: 3000 }), 'dead');
  let state = await call('inspect', key());
  assert.equal(state[0].state, 'dead');
  assert.equal(state[0].attempts, 3);
  failure = undefined;
  await call('repair', key());
  await call('deliver', key());
  state = await call('inspect', key());
  assert.equal(state[0].state, 'submitted');
  vectors.clear();
  await call('repair', key());
  await call('deliver', key());
  assert.equal(vectors.size, 1);
  assert.equal(await call('repair', key(1, 'beta')), false);
});

test('invalid persisted snapshot and interrupted final attempt recover through repair', async () => {
  await call('enqueue', snapshot());
  await db
    .prepare("UPDATE semantic_versions SET payload=json_set(payload,'$.projectId','beta')")
    .run();
  assert.equal(await call('deliver', key()), 'retry');
  assert.equal(vectors.size, 0);
  await db.prepare('UPDATE semantic_outbox SET attempts=3,next_attempt=0').run();
  assert.equal(await call('deliver', key()), 'skipped');
  await call('repair', key());
  assert.equal((await call('inspect', key()))[0].attempts, 0);
});

test('external acceptance followed by D1 acknowledgement failure is safely retried', async () => {
  await call('enqueue', snapshot());
  await db
    .prepare(
      "CREATE TRIGGER fail_ack BEFORE UPDATE ON semantic_outbox WHEN NEW.state='submitted' BEGIN SELECT RAISE(ABORT,'test'); END",
    )
    .run();
  assert.equal(await call('deliver', { ...key(), now: 0 }), 'retry');
  assert.equal(vectors.size, 1);
  await db.prepare('DROP TRIGGER fail_ack').run();
  assert.equal(await call('deliver', { ...key(), now: 1000 }), 'submitted');
  assert.equal(vectors.size, 1);
  await Promise.all([call('enqueue', snapshot(3)), call('enqueue', snapshot(2))]);
  assert.equal((await db.prepare('SELECT revision FROM semantic_heads').first()).revision, 3);
});

test('snapshot rejects invalid vectors, duplicates, size and identity before DB writes', async () => {
  for (const change of [
    { revision: 0 },
    { projectId: 'a'.repeat(65) },
    { chunks: Array(17).fill(snapshot().chunks[0]) },
    { chunks: [snapshot().chunks[0], snapshot().chunks[0]] },
    { chunks: [{ ...snapshot().chunks[0], values: [1] }] },
  ])
    await call('enqueue', { ...snapshot(), ...change }, 503);
  const huge = snapshot();
  huge.chunks[0].candidate.snippet = 'x'.repeat(100_000);
  await call('enqueue', huge, 503);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM semantic_versions').first()).n, 0);
});

test('fetch-only Gemini/OpenAI clients execute in workerd, batching and validating HTTP boundaries', async () => {
  for (const provider of ['gemini', 'openai']) {
    calls = [];
    const result = await call('embedding', {
      provider,
      texts: Array.from({ length: 101 }, (_, i) => `synthetic-${i}`),
    });
    assert.equal(result.length, 101);
    assert.equal(result[0].length, 1536);
    assert.deepEqual(
      result.map((v) => v[0]),
      Array.from({ length: 101 }, (_, i) => i + 1),
    );
    assert.equal(calls.filter((c) => c.method === 'embedding').length, 2);
    embeddingReply =
      provider === 'openai'
        ? { data: [{ index: 0, embedding: [1] }] }
        : { embeddings: [{ values: [1] }] };
    await call('embedding', { provider, texts: ['synthetic'] }, 503);
    embeddingReply = undefined;
  }
});
