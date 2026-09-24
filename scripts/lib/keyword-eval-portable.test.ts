import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { evaluateKeywordRun, parseKeywordRun } from './keyword-eval.ts';
import { validateKeywordEvalUrl } from './keyword-eval-local.ts';
import { collectPortableKeywords } from './keyword-eval-portable.ts';
import {
  keywordLike,
  keywordNgrams,
  keywordNumericTokenPatterns,
  normalizeKeyword,
  portableProviders,
  portableQuery,
} from './keyword-eval-portable-query.ts';

test('normalization and grams preserve literal/code-point semantics', () => {
  assert.equal(normalizeKeyword(' ＮｅｂｕｌａＮｏｔｅ '), 'nebulanote');
  assert.equal(keywordLike('a%_\\b'), '%a\\%\\_\\\\b%');
  assert.deepEqual(keywordNumericTokenPatterns('invoice 31415'), ['(^|[^0-9])31415([^0-9]|$)']);
  assert.deepEqual(keywordNumericTokenPatterns('日本語'), []);
  assert.deepEqual(keywordNgrams('𠮷野家', 2), ['𠮷野', '野家']);
  assert.deepEqual(keywordNgrams('aaaa', 2), ['aa']);
  assert.deepEqual(keywordNgrams('', 2), []);
  assert.deepEqual(keywordNgrams('星', 2), ['星']);
});

test('DB guard rejects remote, app database, options and fragments before connecting', () => {
  validateKeywordEvalUrl('postgres://postgres@127.0.0.1:5750/keyword_eval');
  for (const url of [
    'postgres://example.invalid/keyword_eval',
    'postgres://localhost/app',
    'postgres://localhost/keyword_eval?host=remote',
    'postgres://localhost/keyword_eval#x',
    'https://localhost/keyword_eval',
  ])
    assert.throws(() => validateKeywordEvalUrl(url));
});

test('recorded candidates retain fixed judgments and quality failures', async () => {
  const snapshots: unknown = JSON.parse(
    await readFile(
      new URL('../../fixtures/keyword/portable-spike-v1.json', import.meta.url),
      'utf8',
    ),
  );
  assert.ok(Array.isArray(snapshots));
  assert.equal(snapshots.length, portableProviders.length);
  const baseline = parseKeywordRun(
    JSON.parse(
      await readFile(
        new URL('../../fixtures/keyword/pgroonga-baseline-v1.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  for (const entry of snapshots) {
    const run = parseKeywordRun(entry.run);
    const report = evaluateKeywordRun(run, baseline);
    const passing = [
      'trgm-like-word-gin',
      'trgm-like-word-gist',
      'bigram-fuzzy',
      'trigram-fuzzy',
      'bigram-word',
    ];
    assert.equal(report.gate, passing.includes(run.provider), run.provider);
    assert.equal(report.cases.find((c) => c.id === 'isolation')?.hardPass, true);
  }
});

const databaseUrl = process.env.KEYWORD_EVAL_DATABASE_URL;
test('spike refuses missing baseline without a report, while single evaluation permits it', () => {
  const spike = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'scripts/keyword-eval.ts',
      'evaluate-spike',
      '--input',
      'fixtures/keyword/portable-spike-v1.json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(spike.status, 1);
  assert.equal(spike.stdout, '');
  assert.match(spike.stderr, /Keyword evaluation failed/);
  const single = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'scripts/keyword-eval.ts',
      'evaluate',
      '--input',
      'fixtures/keyword/pgroonga-baseline-v1.json',
    ],
    { encoding: 'utf8' },
  );
  // This recorded baseline has known quality failures, but evaluation still produces a report.
  assert.equal(single.status, 1);
  assert.equal(JSON.parse(single.stdout).comparisonComplete, false);
});

test('offline spike CLI reports every candidate and fails for recorded negative controls', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'scripts/keyword-eval.ts',
      'evaluate-spike',
      '--input',
      'fixtures/keyword/portable-spike-v1.json',
      '--baseline',
      'fixtures/keyword/pgroonga-baseline-v1.json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, portableProviders.length);
  assert.equal(reports.filter((r: { gate: boolean }) => r.gate).length, 5);
  assert.ok(reports.every((r: { comparisonComplete: boolean }) => r.comparisonComplete));
  assert.equal(result.stdout.includes('QUERY PLAN'), false);
});

test('live spike repeats recorded ranks, protects existing schema, and rolls back failures', {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const recorded: { run: unknown }[] = JSON.parse(
    await readFile(
      new URL('../../fixtures/keyword/portable-spike-v1.json', import.meta.url),
      'utf8',
    ),
  );
  const collected = await collectPortableKeywords(databaseUrl);
  for (const { run } of collected) {
    const expected = recorded
      .map((r) => parseKeywordRun(r.run))
      .find((r) => r.provider === run.provider);
    assert.ok(expected);
    assert.deepEqual(
      run.cases.map((c) => c.chunkIds),
      expected.cases.map((c) => c.chunkIds),
      run.provider,
    );
  }
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    assert.equal(
      (await sql`SELECT 1 FROM pg_namespace WHERE nspname = 'keyword_eval_portable'`).length,
      0,
    );
    await sql`CREATE SCHEMA keyword_eval_portable`;
    try {
      await assert.rejects(collectPortableKeywords(databaseUrl));
      assert.equal(
        (await sql`SELECT 1 FROM pg_namespace WHERE nspname = 'keyword_eval_portable'`).length,
        1,
      );
    } finally {
      await sql`DROP SCHEMA keyword_eval_portable`;
    }
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`CREATE SCHEMA keyword_eval_portable`;
        await tx`CREATE TABLE keyword_eval_portable.chunks (id text, document_id text, project_id text, content text)`;
        await tx`INSERT INTO keyword_eval_portable.chunks VALUES ('literal','literal','alpha','literal %_\\ value'), ('wildcard','wildcard','alpha','other'), ('foreign','foreign','beta','literal %_\\ value')`;
        const rows = await portableQuery(tx, 'trgm-like-word-gin', 'alpha', '%_\\');
        assert.deepEqual(
          rows.map((r) => r.id),
          ['literal'],
        );
        throw new Error('intentional rollback');
      }),
      /intentional rollback/,
    );
    assert.equal(
      (await sql`SELECT 1 FROM pg_namespace WHERE nspname = 'keyword_eval_portable'`).length,
      0,
    );
  } finally {
    await sql.end();
  }
});
