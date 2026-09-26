import assert from 'node:assert/strict';
import test from 'node:test';
import { parityRetrievalDocuments } from './parity-retrieval.ts';
import { withPostgresParityCandidates } from './parity-retrieval-postgres.ts';

const url = process.env.KEYWORD_EVAL_DATABASE_URL;
test('disposable PostgreSQL Chat hydrates first stored chunk and scopes document and Graph reads', {
  skip: !url,
}, async () => {
  assert.ok(url);
  await withPostgresParityCandidates(url, async (_candidates, database) => {
    const expected = parityRetrievalDocuments().find((d) => d.documentId === 'd01')?.chunks[0]
      ?.candidate;
    assert.ok(expected);
    const result = await database.documentFetch({ projectId: 'alpha', documentIds: ['d01'] });
    assert.equal(result[0]?.snippet, expected.snippet?.slice(0, 700).trim());
    assert.deepEqual(await database.documentFetch({ projectId: 'beta', documentIds: ['d01'] }), []);
    assert.deepEqual(
      await database.documentFetch({ projectId: 'alpha', documentIds: ['missing'] }),
      [],
    );
    const graph = await database.graphCoverageQuery({
      projectId: 'alpha',
      question: '',
      seedDocumentIds: ['d01'],
    });
    assert.equal(graph.queryFailed, false);
    assert.ok(
      graph.candidates.some(
        (c) => c.relationType === 'MENTIONS' && c.hopCount === 2 && c.documentId === 'd03',
      ),
    );
    const foreign = await database.graphCoverageQuery({
      projectId: 'beta',
      question: '',
      seedDocumentIds: ['d01'],
    });
    assert.deepEqual(foreign.candidates, []);
  });
});
