import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { syntheticEmbeddingArtifactFixture } from './parity-embedding-artifact.fixture.ts';
import { parseParityEmbeddingArtifact } from './parity-embedding-artifact.ts';
import { parityFixture } from './parity-fixture.ts';
import { parityRetrievalDocuments } from './parity-retrieval.ts';

function first<T>(items: T[]): T {
  const item = items[0];
  assert.ok(item);
  return item;
}

test('saved input covers 37 chunks and 3 shared questions, copies values and pins file checksum', () => {
  const fixture = syntheticEmbeddingArtifactFixture();
  const json = JSON.stringify(fixture);
  const { input, provenance } = parseParityEmbeddingArtifact(json);
  assert.equal(provenance.checksum, createHash('sha256').update(json).digest('hex'));
  assert.equal(fixture.chunks.length, 37);
  assert.equal(fixture.queries.length, 3);
  for (const query of fixture.queries) {
    assert.equal(query.caseIds.length, 2);
    for (const id of query.caseIds) assert.deepEqual(input.queryVector(id), query.values);
  }
  const documents = parityRetrievalDocuments(input);
  for (const chunk of documents.flatMap((d) => d.chunks)) {
    assert.deepEqual(
      chunk.values,
      fixture.chunks.find((c) => c.id === chunk.candidate.chunkId)?.values,
    );
  }
  assert.notDeepEqual(
    documents[0]?.chunks[0]?.values,
    parityRetrievalDocuments()[0]?.chunks[0]?.values,
  );
  const first = fixture.chunks[0];
  assert.ok(first);
  input.chunkVector(first.id).fill(0);
  assert.deepEqual(input.chunkVector(first.id), first.values);
  assert.throws(() => input.queryVector('chat-design'), /Missing/);
  fixture.embedding.mode = 'real';
  const declaredReal = parseParityEmbeddingArtifact(JSON.stringify(fixture));
  assert.equal(declaredReal.provenance.originVerified, false);
  assert.equal(declaredReal.provenance.semanticQualityMeasured, false);
  assert.equal(declaredReal.provenance.chatSupported, false);
});

test('artifact rejects mismatched contract, identities, coverage and unsafe vectors without echoing data', () => {
  const mutations: ((value: ReturnType<typeof syntheticEmbeddingArtifactFixture>) => void)[] = [
    (v) => {
      v.version = 'unknown';
    },
    (v) => {
      v.fixtureHash = 'bad';
    },
    (v) => {
      v.schemaHash = 'bad';
    },
    (v) => {
      v.mappingHash = 'bad';
    },
    (v) => {
      v.embedding.mode = 'unknown';
    },
    (v) => {
      Object.assign(v.embedding, { model: 'other', dimensions: 3 });
    },
    (v) => {
      Object.assign(v, { schemaVersion: 2 });
    },
    (v) => {
      v.chunks.pop();
    },
    (v) => {
      v.queries.pop();
    },
    (v) => {
      v.chunks.push(first(v.chunks));
    },
    (v) => {
      v.chunks[1] = first(v.chunks);
    },
    (v) => {
      v.queries[1] = first(v.queries);
    },
    (v) => {
      first(v.chunks).textHash = 'private-text';
    },
    (v) => {
      first(v.chunks).documentId = 'wrong';
    },
    (v) => {
      first(v.queries).projectId = 'wrong';
    },
    (v) => {
      first(v.queries).caseIds.pop();
    },
    (v) => {
      first(v.chunks).values.pop();
    },
    (v) => {
      first(v.queries).values.fill(0);
    },
    (v) => {
      first(v.chunks).values[0] = Number.NaN;
    },
    (v) => {
      first(v.chunks).values[0] = Number.POSITIVE_INFINITY;
    },
    (v) => {
      first(v.chunks).values[0] = 1e100;
    },
    (v) => {
      first(v.chunks).values.fill(1e-100);
    },
  ];
  for (const mutate of mutations) {
    const fixture = syntheticEmbeddingArtifactFixture();
    mutate(fixture);
    assert.throws(
      () => parseParityEmbeddingArtifact(JSON.stringify(fixture)),
      /^Error: Invalid embedding artifact/,
    );
  }
  assert.throws(
    () => parseParityEmbeddingArtifact('{ private-text'),
    /^Error: Invalid embedding artifact JSON$/,
  );
  assert.equal(parityFixture.embedding.model, 'text-embedding-3-small');
});
