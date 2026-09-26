import assert from 'node:assert/strict';
import test from 'node:test';
import { parityFixture } from './parity-fixture.ts';
import {
  collectSyntheticRetrieval,
  parityRetrievalDocuments,
  syntheticParityVector,
} from './parity-retrieval.ts';
import { collectPostgresSyntheticRetrieval } from './parity-retrieval-postgres.ts';

test('independent text projection covers the full shared fixture and repeated input is stable', () => {
  const documents = parityRetrievalDocuments();
  assert.equal(documents.length, 36);
  assert.deepEqual(
    documents.flatMap((d) => d.chunks.map((c) => c.candidate.chunkId)).sort(),
    parityFixture.chunks.map((c) => c.id).sort(),
  );
  const values = syntheticParityVector('independent input');
  assert.equal(values.length, 1536);
  assert.ok(Math.abs(Math.hypot(...values) - 1) < 1e-12);
  assert.deepEqual(syntheticParityVector('independent input'), values);
  assert.notDeepEqual(syntheticParityVector('different input'), values);
});

test('collector preserves adapter ranks and source selection; missing observations stay null', async () => {
  const documents = parityRetrievalDocuments();
  const candidate = documents.find((d) => d.documentId === 'd05')?.chunks[0]?.candidate;
  assert.ok(candidate);
  let semanticCalls = 0;
  let keywordCalls = 0;
  const result = await collectSyntheticRetrieval({
    semanticCandidateRepository: {
      async search(input) {
        semanticCalls++;
        assert.equal(input.preDedupLimit, 37);
        return [{ ...candidate, cosineDistance: 0.9, rank: 1 }];
      },
    },
    keywordCandidateRepository: {
      async search() {
        keywordCalls++;
        return [];
      },
    },
  });
  assert.equal(semanticCalls, 6);
  assert.equal(keywordCalls, 3);
  assert.equal(result.qualityGate, false);
  assert.ok(result.rows.every((row) => row.chunkIds[0] === candidate.chunkId));
  assert.ok(
    result.rows.every(
      (row) => row.scopePass && row.mutationPass === null && row.rubricPass === null,
    ),
  );
  assert.ok(
    result.rows
      .filter((row) => row.id.startsWith('hybrid'))
      .every((row) => row.finalDocumentIds[0] === 'd05'),
  );
});

test('collector rejects malformed provenance but records valid foreign candidates as scope failure', async () => {
  const foreign = parityRetrievalDocuments().find((d) => d.projectId === 'beta')?.chunks[0]
    ?.candidate;
  assert.ok(foreign);
  const repositories = {
    semanticCandidateRepository: {
      async search() {
        return [{ ...foreign, rank: 1, cosineDistance: 0.1 }];
      },
    },
    keywordCandidateRepository: {
      async search() {
        return [];
      },
    },
  };
  const result = await collectSyntheticRetrieval(repositories);
  assert.ok(result.rows.every((row) => row.scopePass === false));
  await assert.rejects(
    collectSyntheticRetrieval({
      ...repositories,
      semanticCandidateRepository: {
        async search() {
          return [{ ...foreign, documentId: 'd01', rank: 1, cosineDistance: 0.1 }];
        },
      },
    }),
    /provenance/,
  );
  await assert.rejects(
    collectSyntheticRetrieval({
      ...repositories,
      semanticCandidateRepository: {
        async search() {
          throw new Error('unavailable');
        },
      },
    }),
    /unavailable/,
  );
});

test('hybrid fuses both observed rankings and applies normalized source cutoff', async () => {
  const documents = parityRetrievalDocuments();
  const first = documents.find((d) => d.documentId === 'd01')?.chunks[0]?.candidate;
  const second = documents.find((d) => d.documentId === 'd05')?.chunks[0]?.candidate;
  assert.ok(first && second);
  const result = await collectSyntheticRetrieval({
    semanticCandidateRepository: {
      async search() {
        return [{ ...second, rank: 1, cosineDistance: 0.8 }];
      },
    },
    keywordCandidateRepository: {
      async search() {
        return [
          { ...first, rank: 1 },
          { ...second, rank: 2 },
        ];
      },
    },
  });
  for (const row of result.rows.filter((row) => row.id.startsWith('hybrid-'))) {
    assert.deepEqual(row.chunkIds, [second.chunkId, first.chunkId]);
    assert.deepEqual(row.finalDocumentIds, [second.documentId]);
  }
});

test('real loopback pgvector/PGroonga collect synthetic observations', {
  skip: !process.env.KEYWORD_EVAL_DATABASE_URL,
}, async () => {
  const result = await collectPostgresSyntheticRetrieval(
    process.env.KEYWORD_EVAL_DATABASE_URL ?? '',
  );
  assert.equal(result.rows.length, 6);
  assert.ok(result.rows.every((row) => row.scopePass && row.chunkIds.length === 10));
  assert.equal(result.embedding.mode, 'synthetic');
  assert.equal(result.qualityGate, false);
});

test('PostgreSQL collector rejects remote and non-dedicated URLs before connecting', async () => {
  for (const url of ['postgres://remote.invalid/keyword_eval', 'postgres://localhost/production'])
    await assert.rejects(collectPostgresSyntheticRetrieval(url), /loopback evaluation DB/);
});
