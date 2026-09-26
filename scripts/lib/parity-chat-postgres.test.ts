import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSyntheticChat } from './parity-chat.ts';
import { assertClassifiedPriority } from './parity-chat-classified.fixture.ts';
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

test('PostgreSQL real candidates drive controlled retry and Graph final selection', {
  skip: !url,
}, async () => {
  assert.ok(url);
  const result = await withPostgresParityCandidates(url, collectSyntheticChat);
  assertClassifiedPriority(result.classifiedPriority);
  assert.ok(result.observations.every((row) => !row.retry.decision && !row.retry.executed));
  const retry = result.controlled.observations.find((row) => row.id === 'primary-empty-retry');
  assert.equal(retry?.retry.executed, true);
  assert.equal(retry.hybridReads.filter((read) => read.phase === 'retry').length, 1);
  assert.ok(retry.retry.afterDocumentIds.length > 0);
  assert.ok(retry.graphReads[0]?.relations.some((tuple) => tuple[1] === 'RELATED_TO'));
  const graph = result.controlled.observations.find((row) => row.id === 'single-seed-graph-final');
  assert.deepEqual(graph?.graphReads[0]?.seeds, ['d01']);
  assert.deepEqual(graph?.graphAdoptedDocumentIds, ['d02']);
  assert.deepEqual(graph?.finalGraphDocumentIds, ['d02']);
  assert.deepEqual(graph?.finalDocumentIds, ['d01', 'd02']);
  assert.equal(graph?.graphMetadataAtFinalSelection, false);
  assert.equal(graph?.sourceRedactionPass, true);
  assert.equal(graph?.workflowHttpRequests, 2);
});
