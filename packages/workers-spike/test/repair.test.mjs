import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { runRepair } from '../repair.mjs';

test('local repair CLI persists scoped changes and defaults to inspection without network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pufu-semantic-repair-'));
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(); } }',
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: 'semantic-local' },
    d1Persist: directory,
  });
  try {
    const db = await runtime.getD1Database('DB');
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
    await db.prepare("INSERT INTO projects VALUES ('alpha')").run();
    await db.prepare("INSERT INTO semantic_versions VALUES ('alpha','doc',1,'{}')").run();
    await db.prepare("INSERT INTO semantic_heads VALUES ('alpha','doc',1)").run();
    await db
      .prepare("INSERT INTO semantic_outbox VALUES ('alpha','doc',1,'dead',3,3000,NULL,0)")
      .run();
  } finally {
    await runtime.dispose();
  }
  try {
    const args = ['--state-dir', directory, '--project', 'alpha', '--document', 'doc'];
    assert.equal((await runRepair(args))[0].state, 'dead');
    await assert.rejects(runRepair([...args, '--apply']));
    await assert.rejects(runRepair([...args, '--revision', '-1', '--apply']));
    assert.equal(await runRepair([...args, '--revision', '1', '--apply']), true);
    const result = await runRepair(args);
    assert.equal(result[0].state, 'pending');
    assert.equal(result[0].attempts, 0);
    assert.deepEqual(
      await runRepair(['--state-dir', directory, '--project', 'beta', '--document', 'doc']),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
