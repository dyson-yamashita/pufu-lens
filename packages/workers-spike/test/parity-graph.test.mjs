import assert from 'node:assert/strict';
import test from 'node:test';
import { parityFixture } from '../../../scripts/lib/parity-fixture.ts';
import { collectPostgresGraphParity } from '../../../scripts/lib/parity-graph-postgres.ts';
import { collectD1GraphParity } from '../parity-graph-local.mjs';

test('real PostgreSQL and D1 Graph observations agree, preserving the v1 MENTIONS mismatch', {
  skip: !process.env.KEYWORD_EVAL_DATABASE_URL,
}, async () => {
  const pg = await collectPostgresGraphParity(process.env.KEYWORD_EVAL_DATABASE_URL);
  const d1 = await collectD1GraphParity();
  assert.deepEqual(pg.rows, d1.rows);
  assert.equal(pg.rows.length, 17);
  for (const row of pg.rows) {
    assert.equal(row.scopePass, true, row.id);
    assert.equal(row.mutationPass, true, row.id);
    const expected = parityFixture.cases.find((c) => c.id === row.id).graph;
    if (row.id === 'graph-MENTIONS') {
      assert.deepEqual(row.graph, []);
      assert.notDeepEqual(row.graph, expected);
    } else assert.deepEqual([...row.graph].sort(), [...expected].sort(), row.id);
  }
  for (const run of [pg, d1])
    for (const observation of run.observations) {
      assert.equal(observation.inputObserved, true);
      assert.equal(observation.sentinelPresent, true);
      assert.equal(observation.sentinelUnchanged, true);
      assert.equal(observation.foreignSeedRejected, true);
    }
});

test('Graph PostgreSQL collector rejects non-dedicated or remote URLs before connecting', async () => {
  for (const url of [
    'postgres://localhost/production',
    'postgres://example.com/keyword_eval',
    'postgres://localhost/keyword_eval?host=example.com',
  ])
    await assert.rejects(collectPostgresGraphParity(url), /loopback evaluation DB/);
});
