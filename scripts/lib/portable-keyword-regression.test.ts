import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import postgres from 'postgres';
import { validateKeywordEvalUrl } from './keyword-eval-local.ts';

test('portable term policy generalizes beyond the quality holdout', {
  skip: !process.env.KEYWORD_EVAL_DATABASE_URL,
}, async () => {
  const url = process.env.KEYWORD_EVAL_DATABASE_URL;
  assert.ok(url);
  validateKeywordEvalUrl(url);
  const { createPostgresPortableKeywordCandidateRepository } = await import(
    '../../apps/web/src/postgres-portable-keyword-adapter.ts'
  );
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const projectId = randomUUID();
  const suffix = projectId.replaceAll('-', '');
  const documents = [
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
  const ids = documents.map(() => randomUUID());
  let created = false;
  try {
    await sql`INSERT INTO projects (id, slug, name, graph_name, storage_prefix)
      VALUES (${projectId}, ${`quality-${suffix}`}, 'Synthetic regression', ${`graph_quality_${suffix}`}, ${suffix})`;
    created = true;
    for (const [index, content] of documents.entries()) {
      const id = ids[index];
      assert.ok(id);
      await sql`INSERT INTO raw_documents (id, project_id, source_type, source_id, logical_source_id, source_version, storage_uri, content_hash)
        VALUES (${id}, ${projectId}, 'web', ${id}, ${id}, 'v1', 'synthetic://regression', ${id})`;
      await sql`INSERT INTO documents (id, project_id, raw_document_id, doc_type, logical_source_id, graph_node_id)
        VALUES (${id}, ${projectId}, ${id}, 'web_page', ${id}, ${id})`;
      await sql`INSERT INTO document_chunks (id, project_id, document_id, chunk_index, content, content_hash)
        VALUES (${id}, ${projectId}, ${id}, 0, ${content}, ${id})`;
    }
    const repository = createPostgresPortableKeywordCandidateRepository(sql);
    const cases: readonly [string, readonly number[]][] = [
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
    for (const [query, expected] of cases) {
      const rows = await repository.search({ projectId, normalizedQuery: query, limit: 20 });
      assert.deepEqual(
        rows.map((row) => row.documentId).sort(),
        expected.map((index) => ids[index]).sort(),
        query,
      );
    }
  } finally {
    try {
      if (created) await sql`DELETE FROM projects WHERE id = ${projectId}`;
    } finally {
      await sql.end();
    }
  }
});
