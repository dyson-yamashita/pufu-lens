import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { evaluateKeywordRun, parseKeywordRun } from './keyword-eval.ts';
import { collectPgroongaBaseline } from './keyword-eval-pgroonga.ts';

const databaseUrl = process.env.KEYWORD_EVAL_DATABASE_URL;

test('PGroonga collection repeats ranks, retains known failures and leaves no schema', {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const run = await collectPgroongaBaseline(databaseUrl);
  const repeated = await collectPgroongaBaseline(databaseUrl);
  assert.deepEqual(
    run.cases.map((row) => row.chunkIds),
    repeated.cases.map((row) => row.chunkIds),
  );
  const report = evaluateKeywordRun(run);
  assert.equal(report.gate, false);
  assert.equal(report.cases.find((row) => row.id === 'typo')?.recall, 0);
  assert.equal(report.cases.find((row) => row.id === 'isolation')?.hardPass, true);
  const recorded = parseKeywordRun(
    JSON.parse(
      await readFile(
        new URL('../../fixtures/keyword/pgroonga-baseline-v1.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  if (run.environment === recorded.environment) {
    assert.deepEqual(
      run.cases.map((row) => row.chunkIds),
      recorded.cases.map((row) => row.chunkIds),
    );
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    assert.equal(
      (await sql`SELECT 1 FROM pg_namespace WHERE nspname = 'keyword_eval_synthetic'`).length,
      0,
    );
    await sql`CREATE SCHEMA keyword_eval_synthetic`;
    try {
      await assert.rejects(collectPgroongaBaseline(databaseUrl));
      assert.equal(
        (await sql`SELECT 1 FROM pg_namespace WHERE nspname = 'keyword_eval_synthetic'`).length,
        1,
      );
    } finally {
      await sql`DROP SCHEMA keyword_eval_synthetic`;
    }
  } finally {
    await sql.end();
  }
});
