import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { localStaging, localToken } from '../local-staging.mjs';
import { runStagingFixture } from '../staging-fixture.mjs';

let local;
before(async () => {
  local = await localStaging();
});
after(async () => {
  await local?.runtime.dispose();
});
beforeEach(async () => {
  local.vectors.clear();
  local.calls.length = 0;
  local.state.failure = local.state.override = local.state.afterQuery = null;
  local.state.description = { dimensions: 1536, metric: 'cosine' };
  for (const table of [
    'semantic_outbox',
    'semantic_heads',
    'semantic_versions',
    'keyword_documents',
    'graph_nodes',
    'projects',
  ])
    await local.db.prepare(`DELETE FROM ${table}`).run();
});
async function ok(operation, input) {
  const reply = await local.call(operation, input);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.result;
}

test('versioned two-project fixture exercises Graph, keyword, semantic, hybrid, update, tombstone and repair', async () => {
  const report = await runStagingFixture(local.call);
  assert.equal(report.requests, 40);
  assert.equal(report.outcome, 'passed');
  assert.equal(report.remoteGate, 'not-run');
  assert.equal(local.vectors.size, 12);
  assert.ok(
    local.calls
      .filter((v) => v.method === 'query')
      .every(({ body }) => body.options.namespace === body.options.filter.projectId),
  );
});

test('unauthenticated/invalid controls touch no bindings and expose no details', async () => {
  assert.equal((await local.call('seed', {}, '')).status, 401);
  assert.equal((await local.call('seed', {}, 'wrong')).status, 401);
  for (const input of [
    { projectId: 'production' },
    { document: 4 },
    { revision: 4 },
    { profile: 'gcp-postgres' },
    { content: 'secret' },
  ])
    assert.equal((await local.call('seed', input)).status, 400);
  assert.equal((await local.call('unknown')).status, 400);
  for (const body of ['{', 'x'.repeat(1025)]) {
    const response = await local.runtime.dispatchFetch('http://local.test/evaluate', {
      method: 'POST',
      headers: { authorization: `Bearer ${localToken}` },
      body,
    });
    assert.equal(response.status, 400);
  }
  assert.equal(local.calls.length, 0);
  assert.equal((await local.db.prepare('SELECT count(*) AS n FROM projects').first()).n, 0);
  const response = await local.runtime.dispatchFetch('http://local.test/probe');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('profile, expiry, model, dimension, metadata and schema configuration fail closed', async () => {
  for (const bindings of [
    { PUFU_LENS_DATA_PROFILE: '' },
    { STAGE: 'production' },
    { EMBEDDING_MODEL: 'wrong' },
    { EMBEDDING_DIMENSIONS: '768' },
    { INDEXED_METADATA: 'projectId' },
    { FIXTURE_VERSION: 'next' },
    { SCHEMA_VERSION: 'next' },
    { EXPIRES_AT: '2020-01-01' },
    { EXPIRES_AT: '2099-01-01' },
    { EVAL_TOKEN: '' },
  ]) {
    const invalid = await localStaging({ bindings, migrate: false });
    try {
      assert.equal((await invalid.call('seed')).status, 503);
      assert.equal(invalid.calls.length, 0);
    } finally {
      await invalid.runtime.dispose();
    }
  }
});

test('native entry refuses missing Vectorize; missing/incomplete D1 schema and live index mismatch fail closed', async () => {
  for (const options of [{ nativeEntry: true, migrate: false }, { migrate: false }]) {
    const invalid = await localStaging(options);
    try {
      assert.equal((await invalid.call('health')).status, 503);
    } finally {
      await invalid.runtime.dispose();
    }
  }
  local.state.description = { dimensions: 768, metric: 'cosine' };
  assert.equal((await local.call('seed')).status, 503);
  local.state.description = { dimensions: 1536, metric: 'euclidean' };
  assert.equal((await local.call('seed')).status, 503);
  local.state.description = { dimensions: 1536, metric: 'cosine' };
  await local.db.prepare("UPDATE spike_schema SET version='wrong'").run();
  assert.equal((await local.call('health')).status, 503);
  await local.db.prepare("UPDATE spike_schema SET version='0004_composition'").run();
  await local.db.prepare('ALTER TABLE semantic_outbox RENAME COLUMN epoch TO missing_epoch').run();
  assert.equal((await local.call('health')).status, 503);
  await local.db.prepare('ALTER TABLE semantic_outbox RENAME COLUMN missing_epoch TO epoch').run();
});

test('shared D1 revision preserves latest keyword text after reverse/concurrent/repeated writes', async () => {
  await ok('seed', { revision: 2 });
  await ok('seed', { revision: 1 });
  await ok('seed', { revision: 2 });
  let content = await local.db.prepare('SELECT content FROM keyword_chunks').all();
  assert.ok(content.results.every((r) => r.content.includes('revision 2')));
  await Promise.all([ok('seed', { revision: 1 }), ok('seed', { revision: 3 })]);
  assert.equal((await local.db.prepare('SELECT count(*) AS n FROM keyword_chunks').first()).n, 0);
  assert.equal((await local.db.prepare('SELECT revision FROM semantic_heads').first()).revision, 3);
  await ok('seed', { revision: 2 });
  content = await local.db.prepare('SELECT content FROM keyword_chunks').all();
  assert.equal(content.results.length, 0);
});

test('failure in final keyword posting rolls back semantic version, head, outbox and keyword writes', async () => {
  await ok('seed');
  await local.db
    .prepare(
      "CREATE TRIGGER fail_posting BEFORE INSERT ON keyword_characters BEGIN SELECT RAISE(ABORT,'test'); END",
    )
    .run();
  assert.equal((await local.call('seed', { revision: 2 })).status, 503);
  await local.db.prepare('DROP TRIGGER fail_posting').run();
  assert.equal((await local.db.prepare('SELECT revision FROM semantic_heads').first()).revision, 1);
  assert.equal(
    (await local.db.prepare('SELECT count(*) AS n FROM semantic_versions').first()).n,
    1,
  );
  assert.equal((await local.db.prepare('SELECT count(*) AS n FROM semantic_outbox').first()).n, 1);
  assert.ok(
    (await local.db.prepare('SELECT content FROM keyword_chunks').all()).results.every((r) =>
      r.content.includes('revision 1'),
    ),
  );
  await local.db
    .prepare(
      "UPDATE semantic_versions SET payload=json_set(payload,'$.chunks[0].candidate.title','conflict')",
    )
    .run();
  assert.equal((await local.call('seed')).status, 503);
});

test('dispatcher enforces project scope, four-intent cap, due time, durable dead state and repair', async () => {
  for (const projectId of ['fixture-alpha', 'fixture-beta'])
    for (let document = 0; document < 4; document++) await ok('seed', { projectId, document });
  await ok('seed', { revision: 2 });
  assert.equal((await ok('dispatch')).length, 4);
  assert.ok([...local.vectors.values()].every((v) => v.namespace === 'fixture-alpha'));
  local.state.failure = 'upsert';
  assert.equal((await ok('dispatch'))[0].state, 'retry');
  assert.equal((await ok('dispatch')).length, 0);
  for (let i = 0; i < 2; i++) {
    await local.db
      .prepare(
        "UPDATE semantic_outbox SET next_attempt=0 WHERE project_id='fixture-alpha' AND state='pending'",
      )
      .run();
    await ok('dispatch');
  }
  const dead = await ok('inspect', { document: 3 });
  assert.equal(dead[0].state, 'dead');
  local.state.failure = null;
  await ok('repair', { document: 3 });
  assert.equal((await ok('dispatch'))[0].state, 'submitted');
});

test('stale vector, foreign namespace and concurrent revision changes reject hybrid result', async () => {
  await ok('seed');
  await ok('dispatch');
  const old = [...local.vectors.values()][0];
  await ok('seed', { revision: 2 });
  assert.equal((await local.call('query')).status, 503);
  await ok('dispatch');
  local.vectors.set(old.id, old);
  assert.equal((await local.call('query')).status, 503);
  await ok('repair', { revision: 1 });
  await ok('dispatch');
  assert.equal((await ok('query')).hybrid[0], 'doc-0');
  local.state.override = [{ ...old, namespace: 'fixture-beta', score: 1 }];
  assert.equal((await local.call('query')).status, 503);
  local.state.override = null;
  local.state.afterQuery = async () => {
    await ok('seed', { document: 1 });
  };
  assert.equal((await local.call('query')).status, 503);
});
