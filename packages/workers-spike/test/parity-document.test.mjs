import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { buildWorker } from '../build.mjs';

test('local D1 detail reads persisted changes, first chunk and project scope', async () => {
  const { script } = await buildWorker('parity-document-worker');
  const runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: 'detail-test' },
    outboundService: () => new Response(null, { status: 403 }),
  });
  try {
    const db = await runtime.getD1Database('DB');
    for (const file of ['0001_graph.sql', '0002_keyword.sql']) {
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
    await db
      .prepare(
        "INSERT INTO keyword_documents VALUES ('alpha','d01','raw','web_page','stored','https://synthetic.invalid')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO keyword_chunks VALUES ('alpha','c2','d01',2,'later','later'),('alpha','c1','d01',1,'first','first')",
      )
      .run();
    const fetchRows = async (projectId, documentIds) => {
      const response = await runtime.dispatchFetch('http://local.test/document', {
        method: 'POST',
        body: JSON.stringify({ input: { projectId, documentIds } }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    assert.equal((await fetchRows('alpha', ['d01']))[0].snippet, 'first');
    await db.prepare("UPDATE keyword_chunks SET content='changed' WHERE chunk_id='c1'").run();
    assert.equal((await fetchRows('alpha', ['d01']))[0].snippet, 'changed');
    assert.deepEqual(await fetchRows('beta', ['d01']), []);
    assert.deepEqual(await fetchRows('alpha', ['missing']), []);
    assert.deepEqual(await fetchRows('alpha', []), []);
    await db.prepare("DELETE FROM keyword_documents WHERE document_id='d01'").run();
    assert.deepEqual(await fetchRows('alpha', ['d01']), []);
  } finally {
    await runtime.dispose();
  }
});
