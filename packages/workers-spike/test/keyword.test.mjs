import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { normalizeKeyword } from '@pufu-lens/retrieval';
import { Miniflare } from 'miniflare';
import { corpusHash, evaluateKeywordRun, rankMetrics } from '../../../scripts/lib/keyword-eval.ts';
import { keywordCorpus } from '../../../scripts/lib/keyword-eval-corpus.ts';
import { keywordHoldoutCases } from '../../../scripts/lib/keyword-holdout.ts';
import {
  qualityCases,
  qualityDocuments,
  qualityHybridCases,
} from '../../../scripts/lib/keyword-quality-corpus.ts';
import { buildWorker } from '../build.mjs';

let runtime, db;
before(async () => {
  const { script } = await buildWorker('keyword-worker');
  runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-07-30',
    compatibilityFlags: [],
    d1Databases: { DB: 'synthetic-keyword' },
    outboundService: () => new Response(null, { status: 403 }),
  });
  await runtime.ready;
  db = await runtime.getD1Database('DB');
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
});
after(async () => runtime?.dispose());
async function call(operation, input, status = 200) {
  const response = await runtime.dispatchFetch('http://local.test/keyword', {
    method: 'POST',
    body: JSON.stringify({ operation, input }),
  });
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify({ operation, input, body }));
  return body.result;
}
const search = (projectId, normalizedQuery, limit = 20, status = 200) =>
  call('search', { projectId, normalizedQuery, limit }, status);
const project = (id) => db.prepare('INSERT INTO projects VALUES (?)').bind(id).run();
const document = (projectId, documentId, chunks, extra = {}) => ({
  projectId,
  documentId,
  rawDocumentId: `raw-${documentId}`,
  title: documentId,
  canonicalUri: `https://synthetic.invalid/${documentId}`,
  docType: 'web_page',
  chunks: chunks.map((c, i) => ({ chunkId: c.id, content: c.content, chunkIndex: i })),
  ...extra,
});

test('fixed v1 evaluates application n-grams and FTS5 with unchanged baseline/judgments', async () => {
  for (const id of ['alpha', 'beta']) await project(id);
  for (const id of new Set(keywordCorpus.chunks.map((c) => c.documentId))) {
    const chunks = keywordCorpus.chunks.filter((c) => c.documentId === id);
    await call('replace', document(chunks[0].projectId, id, chunks));
  }
  for (const tokenizer of ['unicode61', 'trigram']) {
    await db
      .prepare(
        `CREATE VIRTUAL TABLE comparison_${tokenizer} USING fts5(project UNINDEXED,chunk UNINDEXED,document UNINDEXED,content,tokenize='${tokenizer}')`,
      )
      .run();
    await db.batch(
      keywordCorpus.chunks.map((c) =>
        db
          .prepare(`INSERT INTO comparison_${tokenizer} VALUES (?,?,?,?)`)
          .bind(c.projectId, c.id, c.documentId, normalizeKeyword(c.content)),
      ),
    );
  }
  const baseline = JSON.parse(
    await readFile(
      new URL('../../../fixtures/keyword/pgroonga-baseline-v1.json', import.meta.url),
      'utf8',
    ),
  );
  const reports = [];
  for (const provider of ['d1-character-bigram', 'd1-fts5-unicode61', 'd1-fts5-trigram']) {
    const cases = [];
    for (const fixture of keywordCorpus.cases) {
      const start = performance.now();
      let chunkIds = [];
      if (provider === 'd1-character-bigram') {
        const result = await search(
          fixture.projectId,
          fixture.query,
          20,
          fixture.reject ? 400 : 200,
        );
        chunkIds = result?.map((c) => c.chunkId) ?? [];
        assert.deepEqual(
          await search(fixture.projectId, fixture.query, 20, fixture.reject ? 400 : 200),
          result,
          'repeat rank/provenance',
        );
      } else if (!fixture.reject && fixture.query.trim()) {
        const query = normalizeKeyword(fixture.query)
          .split(/\s+/u)
          .map((term) => `"${term.replaceAll('"', '""')}"`)
          .join(' AND ');
        const table =
          provider === 'd1-fts5-unicode61' ? 'comparison_unicode61' : 'comparison_trigram';
        const result = await db
          .prepare(
            `SELECT chunk,document FROM ${table} WHERE ${table} MATCH ? AND project=? ORDER BY rank,chunk LIMIT 20`,
          )
          .bind(query, fixture.projectId)
          .all();
        const seen = new Set();
        chunkIds = result.results
          .filter((r) => !seen.has(r.document) && seen.add(r.document))
          .map((r) => r.chunk);
      }
      cases.push({
        id: fixture.id,
        status: fixture.reject ? 'rejected' : 'ok',
        chunkIds,
        latencyMs: [performance.now() - start],
      });
    }
    const run = {
      schemaVersion: 1,
      corpusHash,
      provider,
      environment: 'local-workerd-1.20260730.1',
      cases,
    };
    const report = evaluateKeywordRun(run, baseline);
    reports.push({ run, report });
  }
  await writeFile(
    new URL('../dist/keyword-v1-evaluation.json', import.meta.url),
    JSON.stringify(reports, null, 2),
  );
  console.log(
    'D1 v1:',
    reports.map(({ report: r }) => ({
      provider: r.provider,
      gate: r.gate,
      recall: r.recall,
      mrr: r.mrr,
      failures: r.cases
        .filter((c) => !c.hardPass || (c.recall !== null && c.recall < 1))
        .map((c) => c.id),
    })),
  );
  assert.equal(reports[0].report.gate, true);
  assert.equal(reports[1].report.gate, false);
  assert.equal(reports[2].report.gate, false);
  // Trigram MATCH cannot serve the required one/two-code-point substring policy.
  await db
    .prepare("INSERT INTO comparison_trigram VALUES ('short','cat','cat','黒猫の記録')")
    .run();
  for (const query of ['猫', '黒猫'])
    assert.deepEqual(
      (
        await db
          .prepare('SELECT chunk FROM comparison_trigram WHERE comparison_trigram MATCH ?')
          .bind(`"${query}"`)
          .all()
      ).results,
      [],
    );
});

test('fixed 56-case independent quality holdout preserves complete expected sets', async () => {
  await project('quality');
  for (const [id, content] of qualityDocuments)
    await call('replace', document('quality', id, [{ id, content }]));
  const results = [];
  for (const fixture of qualityCases) {
    const actual = (await search('quality', fixture.query)).map((c) => c.documentId);
    const metrics = rankMetrics(actual, Object.fromEntries(fixture.relevant.map((id) => [id, 1])));
    results.push({
      id: fixture.id,
      category: fixture.category,
      actual,
      expected: fixture.relevant,
      ...metrics,
      missing: fixture.relevant.filter((id) => !actual.includes(id)),
      extra: actual.filter((id) => !fixture.relevant.includes(id)),
    });
  }
  await writeFile(
    new URL('../dist/keyword-holdout-evaluation.json', import.meta.url),
    JSON.stringify(
      {
        schemaVersion: 1,
        corpusHash: createHash('sha256')
          .update(JSON.stringify({ qualityCases, qualityDocuments, qualityHybridCases }))
          .digest('hex'),
        cases: results,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(
    results.filter((r) => r.missing.length || r.extra.length),
    [],
  );
});

test('project/chunk/document scope, raw provenance, rank and chunk-before-dedupe limits', async () => {
  for (const p of ['scope', 'other']) await project(p);
  await call(
    'replace',
    document('scope', 'same', [
      { id: 'a', content: 'ＡＰＩ first' },
      { id: 'b', content: 'API second' },
    ]),
  );
  await call('replace', document('scope', 'next', [{ id: 'c', content: 'API third' }]));
  await call('replace', document('other', 'same', [{ id: 'a', content: 'API secret' }]));
  const candidates = await search('scope', 'api', 2);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    canonicalUri: 'https://synthetic.invalid/same',
    chunkId: 'a',
    chunkIndex: 0,
    documentId: 'same',
    docType: 'web_page',
    rank: 1,
    rawDocumentId: 'raw-same',
    snippet: 'ＡＰＩ first',
    title: 'same',
  });
  assert.deepEqual(
    (await search('scope', 'api', 3)).map((c) => [c.documentId, c.rank]),
    [
      ['same', 1],
      ['next', 2],
    ],
  );
  assert.equal((await search('other', 'api'))[0].snippet, 'API secret');
  await assert.rejects(
    db.prepare("INSERT INTO keyword_chunks VALUES ('missing','a','same',0,'x','x')").run(),
  );
});

test('existing 14-case holdout and independent vocabulary regression retain their judgments', async () => {
  // Original texts from keyword-selected-db.test.ts; the shared judgments are imported unchanged.
  const texts = [
    '黒猫の記録。',
    'カ\u3099ラスとcafe\u0301 🧑‍💻',
    'rate 50% x_y C:\\tmp',
    'invoice 31415',
    'invoice 31416',
    '① ＡＰＩ ﬃ',
  ];
  await project('holdout14');
  for (const [i, content] of texts.entries())
    await call('replace', document('holdout14', String(i), [{ id: String(i), content }]));
  for (const fixture of keywordHoldoutCases)
    assert.deepEqual(
      (await search('holdout14', fixture.query)).map((c) => Number(c.documentId)).sort(),
      [...fixture.expectedChunkIndexes].sort(),
      fixture.id,
    );
  const otherTexts = [
    'deployment 42 cycle 17',
    'deployment 420 cycle 17 note 42',
    'predeployment 42 cycle 17',
    'deployment 17 cycle 42',
    'deployment 42 cycle 42',
    'mode enabled',
    'mode disabled',
    'file 80% D:\\logs',
    'file 80X D:/logs',
    'サクラ観察',
    '機能設計の記録',
  ];
  const cases = [
    ['deployment 42 cycle 17', [0]],
    ['deplyoment 42 cycle 17', [0]],
    ['deployment 17 cycle 42', [3]],
    ['deployment 42 cycle 42', [4]],
    ['deployment 42 cycle 18', []],
    ['mode enabled', [5]],
    ['enabled mode', [5]],
    ['mode disabled', [6]],
    ['mode not', []],
    ['80%', [7]],
    ['D:\\logs', [7]],
    ['.*', []],
    ['サクヲ', [9]],
    ['サヲ', []],
    ['機設計能', [10]],
  ];
  await project('regression');
  for (const [i, content] of otherTexts.entries())
    await call('replace', document('regression', String(i), [{ id: String(i), content }]));
  for (const [query, expected] of cases)
    assert.deepEqual(
      (await search('regression', query)).map((c) => Number(c.documentId)).sort(),
      expected,
      query,
    );
});

test('malformed snapshots and conflicting chunk ownership preserve existing documents', async () => {
  await project('collision');
  await call('replace', document('collision', 'a', [{ id: 'same', content: 'retained' }]));
  await call('replace', document('collision', 'b', [{ id: 'same', content: 'conflict' }]), 503);
  assert.deepEqual(
    (await search('collision', 'retained')).map((c) => c.documentId),
    ['a'],
  );
  assert.deepEqual(
    (
      await db
        .prepare("SELECT document_id FROM keyword_documents WHERE project_id='collision'")
        .all()
    ).results,
    [{ document_id: 'a' }],
  );
  for (const chunks of [
    [{ chunkId: 'x', chunkIndex: -1, content: 'x' }],
    [
      { chunkId: 'x', chunkIndex: 0, content: 'x' },
      { chunkId: 'x', chunkIndex: 1, content: 'y' },
    ],
    [
      { chunkId: 'x', chunkIndex: 0, content: 'x' },
      { chunkId: 'y', chunkIndex: 0, content: 'y' },
    ],
    [{ chunkId: 'x', chunkIndex: 0, content: 'bad\u0000value' }],
  ])
    await call('replace', { ...document('collision', 'a', []), chunks }, 503);
  assert.equal((await search('collision', 'retained')).length, 1);
  await db.prepare("DELETE FROM projects WHERE id='collision'").run();
  for (const table of ['keyword_documents', 'keyword_chunks', 'keyword_characters'])
    assert.deepEqual(
      (await db.prepare(`SELECT * FROM ${table} WHERE project_id='collision'`).all()).results,
      [],
    );
});

test('atomic snapshot replacement removes old tokens and is idempotent, including concurrent retries', async () => {
  await project('mutation');
  const initial = document('mutation', 'doc', [{ id: 'old', content: 'obsolete token' }]);
  await call('replace', initial);
  const updated = document('mutation', 'doc', [{ id: 'new', content: 'fresh token' }], {
    title: 'new title',
  });
  await Promise.all(Array.from({ length: 3 }, () => call('replace', updated)));
  assert.equal((await search('mutation', 'obsolete')).length, 0);
  assert.equal((await search('mutation', 'fresh'))[0].title, 'new title');
  assert.equal(
    (await db.prepare("SELECT * FROM keyword_chunks WHERE project_id='mutation'").all()).results
      .length,
    1,
  );
  await db
    .prepare(
      "CREATE TRIGGER fail_posting BEFORE INSERT ON keyword_characters WHEN NEW.project_id='mutation' AND NEW.token='z' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    )
    .run();
  await call(
    'replace',
    document('mutation', 'doc', [{ id: 'broken', content: 'zzz' }], { title: 'broken' }),
    503,
  );
  assert.equal((await search('mutation', 'fresh'))[0].title, 'new title');
  await db.prepare('DROP TRIGGER fail_posting').run();
  await call('replace', document('mutation', 'doc', []));
  assert.deepEqual(await search('mutation', 'fresh'), []);
});

test('more than 100 tokens/IDs use fixed binds; deletion cascades and rolls back on error', async () => {
  await project('binding');
  const many = Array.from({ length: 110 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
  await call('replace', document('binding', 'doc', [{ id: 'many', content: many }]));
  assert.equal((await search('binding', many))[0].chunkId, 'many');
  await db
    .prepare(
      "CREATE TRIGGER fail_keyword_delete BEFORE DELETE ON keyword_characters WHEN OLD.project_id='binding' BEGIN SELECT RAISE(ABORT,'synthetic delete failure'); END",
    )
    .run();
  const documentIds = ['doc', ...Array.from({ length: 110 }, (_, i) => `missing-${i}`)];
  await call('delete', { projectId: 'binding', documentIds }, 503);
  assert.equal((await search('binding', many)).length, 1);
  await db.prepare('DROP TRIGGER fail_keyword_delete').run();
  await call('delete', { projectId: 'binding', documentIds });
  await call('delete', { projectId: 'binding', documentIds });
  assert.deepEqual(await search('binding', many), []);
  assert.deepEqual(
    (await db.prepare("SELECT * FROM keyword_characters WHERE project_id='binding'").all()).results,
    [],
  );
  assert.equal((await search('other', 'api')).length, 1);
});

test('invalid rows, missing tables and budget overflow are unavailable; empty success is distinct', async () => {
  assert.deepEqual(await search('scope', 'absentphrase'), []);
  for (const q of ['x'.repeat(1001), 'bad\u0000value', '\ud800']) await search('scope', q, 20, 400);
  for (const limit of [0, 1.5, 1001]) await search('scope', 'api', limit, 400);
  await call(
    'replace',
    document('scope', 'oversized', [{ id: 'big', content: 'x'.repeat(8001) }]),
    503,
  );
  await db
    .prepare("UPDATE keyword_documents SET raw_document_id='   ' WHERE project_id='scope'")
    .run()
    .then(
      () => assert.fail('constraint should reject'),
      () => {},
    );
  await db
    .prepare(
      "UPDATE keyword_chunks SET normalized_content='malformed' WHERE project_id='scope' AND chunk_id='a'",
    )
    .run();
  await search('scope', 'api', 20, 503);
  await db
    .prepare(
      "UPDATE keyword_chunks SET normalized_content='api first' WHERE project_id='scope' AND chunk_id='a'",
    )
    .run();
  await db.prepare('ALTER TABLE keyword_characters RENAME TO keyword_characters_unavailable').run();
  assert.deepEqual(await search('scope', '   '), []);
  await search('scope', 'api', 20, 503);
  await db.prepare('ALTER TABLE keyword_characters_unavailable RENAME TO keyword_characters').run();
  await project('budget');
  // A small boundary fixture, not a throughput/load benchmark.
  await db.prepare("INSERT INTO keyword_documents VALUES ('budget','doc','raw','web','','')").run();
  await db
    .prepare(
      "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<1000) INSERT INTO keyword_chunks SELECT 'budget',printf('c%04d',i),'doc',i,'x','x' FROM n",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO keyword_characters SELECT project_id,'x',chunk_id FROM keyword_chunks WHERE project_id='budget'",
    )
    .run();
  await search('budget', 'x', 20, 503);
  await db
    .prepare("DELETE FROM keyword_chunks WHERE project_id='budget' AND chunk_id='c1000'")
    .run();
  assert.equal((await search('budget', 'x', 1000)).length, 1);
});
