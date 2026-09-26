import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syntheticEmbeddingArtifactFixture } from '../../../scripts/lib/parity-embedding-artifact.fixture.ts';
import { localParityBinding, prepareParityBinding, runParityBinding } from '../parity-binding.mjs';

const artifact = () => JSON.stringify(syntheticEmbeddingArtifactFixture());

test('complete shared corpus crosses authenticated workerd/D1 and explicit fake, then cleans vectors', async () => {
  const local = await localParityBinding(artifact());
  try {
    const report = await runParityBinding(local);
    assert.equal(report.requests, 111);
    assert.equal(report.results.length, 3);
    assert.equal(report.vectorize, 'fake-exact-cosine');
    assert.equal(report.qualityGate, false);
    assert.equal(local.fake.size, 0);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM keyword_chunks').first()).n, 0);
    assert.equal(
      (await local.db.prepare('SELECT count(*) AS n FROM semantic_heads WHERE revision=2').first())
        .n,
      36,
    );
    assert.ok(report.results.every((row) => row.semantic.length > 0));
  } finally {
    await local.runtime.dispose();
  }
});

test('auth, unknown input and bounded controls fail before provider access', async () => {
  const local = await localParityBinding(artifact());
  try {
    assert.equal((await local.call('seed', 0, {}, 'wrong')).status, 401);
    for (const [operation, index, extra] of [
      ['seed', 36, {}],
      ['query', 3, {}],
      ['seed', -1, {}],
      ['seed', 0, { sql: 'SELECT 1' }],
      ['unknown', 0, {}],
      ['seed', 0, { data: 'x'.repeat(1025) }],
    ]) {
      assert.equal((await local.call(operation, index, extra)).status, 400);
    }
    assert.equal(local.fake.calls.describe, 0);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM projects').first()).n, 0);
  } finally {
    await local.runtime.dispose();
  }
});

test('artifact validation and deployment hashes reject mismatches; native bundle has no fake', async () => {
  const invalid = syntheticEmbeddingArtifactFixture();
  invalid.chunks.pop();
  await assert.rejects(prepareParityBinding(JSON.stringify(invalid)), /coverage/);
  await assert.rejects(prepareParityBinding(' '.repeat(4_000_001)), /too large/);
  const inconsistent = syntheticEmbeddingArtifactFixture();
  inconsistent.chunks[0].textHash = 'wrong';
  await assert.rejects(prepareParityBinding(JSON.stringify(inconsistent)), /identity/);
  const native = await prepareParityBinding(artifact());
  assert.equal(native.vectorize, 'native-binding-required');
  assert.ok(!native.script.includes('vectorize-fake.invalid'));
  for (const bindings of [
    { ARTIFACT_HASH: 'wrong' },
    { FIXTURE_HASH: 'wrong' },
    { EXPIRES_AT: '2000-01-01' },
  ]) {
    const local = await localParityBinding(artifact(), bindings);
    try {
      assert.equal((await local.call('seed')).status, 503);
      assert.equal(local.fake.calls.describe, 0);
    } finally {
      await local.runtime.dispose();
    }
  }
});

test('schema drift fails closed without seeding fixed documents', async () => {
  const local = await localParityBinding(artifact());
  try {
    await local.db.prepare("UPDATE spike_schema SET version='wrong'").run();
    assert.equal((await local.call('seed')).status, 503);
    assert.equal(local.fake.size, 0);
    assert.equal((await local.db.prepare('SELECT count(*) AS n FROM projects').first()).n, 0);
  } finally {
    await local.runtime.dispose();
  }
});

test('query failure still cleans all fixed documents; repair replays one immutable revision', async () => {
  const local = await localParityBinding(artifact());
  try {
    assert.equal((await local.call('seed')).status, 200);
    assert.equal((await local.call('dispatch')).body.result, 'submitted');
    assert.equal((await local.call('repair')).body.result, true);
    assert.equal((await local.call('dispatch')).body.result, 'submitted');
    local.fake.setStale(true);
    await assert.rejects(runParityBinding(local), /evaluation failed/);
    assert.equal(local.fake.size, 0);
  } finally {
    await local.runtime.dispose();
  }
});
