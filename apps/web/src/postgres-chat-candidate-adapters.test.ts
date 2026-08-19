import assert from 'node:assert/strict';
import type postgres from 'postgres';
import {
  createGcpPostgresCandidateRepositories,
  createPostgresKeywordCandidateRepository,
  createPostgresSemanticCandidateRepository,
} from './postgres-chat-candidate-adapters.ts';

function semanticSqlRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canonical_uri: 'https://example.test/semantic',
    chunk_id: 'chunk-semantic-1',
    chunk_index: 0,
    cosine_distance: '0.21',
    document_id: 'doc-semantic',
    doc_type: 'web_page',
    rank: '1',
    raw_document_id: 'raw-semantic',
    snippet: 'semantic snippet',
    title: 'Semantic Document',
    ...overrides,
  };
}

function keywordSqlRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canonical_uri: 'https://example.test/keyword',
    chunk_id: 'chunk-keyword-1',
    chunk_index: 2,
    document_id: 'doc-keyword',
    doc_type: 'issue',
    rank: '1',
    raw_document_id: 'raw-keyword',
    snippet: 'keyword snippet',
    title: 'Keyword Document',
    ...overrides,
  };
}

function createSqlMock(
  onQuery: (sqlText: string, values: readonly unknown[]) => readonly unknown[],
): {
  readonly boundValues: unknown[][];
  readonly sql: postgres.Sql;
  readonly sqlTexts: string[];
} {
  const sqlTexts: string[] = [];
  const boundValues: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sqlText = strings.join('?');
    sqlTexts.push(sqlText);
    boundValues.push(values);
    return Promise.resolve(onQuery(sqlText, values));
  }) as unknown as postgres.Sql;
  return {
    boundValues,
    sql,
    sqlTexts,
  };
}

const testEmbedding = Array.from({ length: 1536 }, () => 0);

{
  const { boundValues, sql, sqlTexts } = createSqlMock(() => [semanticSqlRow()]);
  const repository = createPostgresSemanticCandidateRepository(sql);

  const candidates = await repository.search({
    embedding: testEmbedding,
    embeddingModel: 'gemini-test',
    limit: 5,
    preDedupLimit: 100,
    projectId: 'project-a',
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.documentId, 'doc-semantic');
  assert.equal(candidates[0]?.rank, 1);
  assert.equal(candidates[0]?.cosineDistance, 0.21);
  assert.equal(candidates[0]?.chunkId, 'chunk-semantic-1');
  assert.equal(candidates[0]?.chunkIndex, 0);
  assert.equal('distance' in (candidates[0] ?? {}), false);
  assert.equal('providerScore' in (candidates[0] ?? {}), false);

  const sqlText = sqlTexts[0] ?? '';
  const values = boundValues[0] ?? [];
  assert.match(sqlText, /<=>/);
  assert.match(sqlText, /embedding_model/);
  assert.match(sqlText, /project_id|projectId/);
  assert.ok(values.includes('project-a'));
  assert.ok(values.includes('gemini-test'));
  assert.match(sqlText, /LIMIT/);
  assert.match(sqlText, /DISTINCT ON/);
  const limitIndex = sqlText.indexOf('LIMIT');
  const distinctOnIndex = sqlText.indexOf('DISTINCT ON');
  assert.ok(limitIndex >= 0);
  assert.ok(distinctOnIndex >= 0);
  assert.ok(limitIndex < distinctOnIndex);
}

{
  const { sql, sqlTexts } = createSqlMock(() => [semanticSqlRow({ rank: '2' })]);
  const repository = createPostgresSemanticCandidateRepository(sql);

  await repository.search({
    embedding: testEmbedding,
    embeddingModel: 'gemini-test',
    limit: 3,
    projectId: 'project-b',
  });

  const sqlText = sqlTexts[0] ?? '';
  assert.match(sqlText, /<=>/);
  assert.match(sqlText, /DISTINCT ON \(d\.id\)|DISTINCT ON \(document_id\)/);
  assert.doesNotMatch(sqlText, /chunk_candidates_limit|vector_chunk_candidates_limit/);
}

{
  const { sql } = createSqlMock(() => [semanticSqlRow({ rank: '0' })]);
  const repository = createPostgresSemanticCandidateRepository(sql);

  await assert.rejects(
    () =>
      repository.search({
        embedding: testEmbedding,
        embeddingModel: 'gemini-test',
        limit: 5,
        projectId: 'project-a',
      }),
    /rank/,
  );
}

{
  const { sql } = createSqlMock(() => [semanticSqlRow({ cosine_distance: '-0.1' })]);
  const repository = createPostgresSemanticCandidateRepository(sql);

  await assert.rejects(
    () =>
      repository.search({
        embedding: testEmbedding,
        embeddingModel: 'gemini-test',
        limit: 5,
        projectId: 'project-a',
      }),
    /cosineDistance/,
  );
}

{
  const { boundValues, sql, sqlTexts } = createSqlMock(() => [keywordSqlRow()]);
  const repository = createPostgresKeywordCandidateRepository(sql);

  const candidates = await repository.search({
    limit: 5,
    normalizedQuery: '仕様変更',
    projectId: 'project-a',
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.documentId, 'doc-keyword');
  assert.equal(candidates[0]?.rank, 1);
  assert.equal(candidates[0]?.chunkId, 'chunk-keyword-1');
  assert.equal(candidates[0]?.chunkIndex, 2);
  assert.equal('keywordScore' in (candidates[0] ?? {}), false);
  assert.equal('providerScore' in (candidates[0] ?? {}), false);

  const sqlText = sqlTexts[0] ?? '';
  const values = boundValues[0] ?? [];
  assert.match(sqlText, /&@~/);
  assert.match(sqlText, /pgroonga_query_escape/);
  assert.match(sqlText, /pgroonga_score/);
  assert.doesNotMatch(sqlText, /<=>/);
  assert.ok(values.includes('project-a'));
  assert.ok(values.includes('仕様変更'));
  assert.match(sqlText, /DISTINCT ON/);
  assert.match(sqlText, /row_number\(\) OVER/);
  const distinctOnIndex = sqlText.indexOf('DISTINCT ON');
  const rowNumberIndex = sqlText.indexOf('row_number() OVER');
  assert.ok(distinctOnIndex >= 0);
  assert.ok(rowNumberIndex >= 0);
  assert.ok(distinctOnIndex < rowNumberIndex);
}

{
  const { sql } = createSqlMock(() => [keywordSqlRow({ chunk_id: '', rank: '1' })]);
  const repository = createPostgresKeywordCandidateRepository(sql);

  await assert.rejects(
    () =>
      repository.search({
        limit: 5,
        normalizedQuery: 'query',
        projectId: 'project-a',
      }),
    /chunkId|chunk/,
  );
}

{
  const semanticSql = createSqlMock(() => [semanticSqlRow()]);
  const keywordSql = createSqlMock(() => [keywordSqlRow()]);
  const semanticRepository = createPostgresSemanticCandidateRepository(semanticSql.sql);
  const keywordRepository = createPostgresKeywordCandidateRepository(keywordSql.sql);

  await semanticRepository.search({
    embedding: testEmbedding,
    embeddingModel: 'gemini-test',
    limit: 5,
    projectId: 'project-a',
  });
  await keywordRepository.search({
    limit: 5,
    normalizedQuery: 'query',
    projectId: 'project-a',
  });

  assert.match(semanticSql.sqlTexts[0] ?? '', /<=>/);
  assert.doesNotMatch(keywordSql.sqlTexts[0] ?? '', /<=>/);
  assert.match(keywordSql.sqlTexts[0] ?? '', /pgroonga_score/);
  assert.doesNotMatch(semanticSql.sqlTexts[0] ?? '', /pgroonga_score/);
}

{
  const { sql } = createSqlMock(() => [semanticSqlRow()]);
  const repositories = createGcpPostgresCandidateRepositories(sql);

  assert.equal(typeof repositories.semanticCandidateRepository.search, 'function');
  assert.equal(typeof repositories.keywordCandidateRepository.search, 'function');

  const semanticCandidates = await repositories.semanticCandidateRepository.search({
    embedding: testEmbedding,
    embeddingModel: 'gemini-test',
    limit: 1,
    projectId: 'project-a',
  });
  assert.equal(semanticCandidates[0]?.cosineDistance, 0.21);
}
