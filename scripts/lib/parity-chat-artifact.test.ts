import assert from 'node:assert/strict';
import test from 'node:test';
import { parityChatEmbeddingManifest, parseParityChatArtifact } from './parity-chat-artifact.ts';
import { parityChatTextHash } from './parity-chat-inputs.ts';
import { syntheticChatArtifactFixture } from './parity-embedding-artifact.fixture.ts';
import { parseParityEmbeddingArtifact } from './parity-embedding-artifact.ts';

function first<T>(items: T[]): T {
  const value = items[0];
  assert.ok(value);
  return value;
}

test('manifest covers fixed-plan conditional phases with exact text and independent identities', () => {
  const manifest = parityChatEmbeddingManifest();
  assert.equal(manifest.queries.length, 20);
  assert.equal(
    parityChatTextHash(JSON.stringify(manifest.queries)),
    'b709e12aeca0f11ceb2ab8d9210dd6eac6a10da5994b16802320e7583ca331a3',
  );
  assert.equal(new Set(manifest.queries.map((q) => q.caseId)).size, 5);
  assert.equal(manifest.retrievalInputs.chunks.length, 37);
  for (const entry of [
    ...manifest.queries,
    ...manifest.retrievalInputs.chunks,
    ...manifest.retrievalInputs.queries,
  ]) {
    assert.ok(entry.text);
    assert.equal(entry.textHash, parityChatTextHash(entry.text));
  }
  for (const caseId of new Set(manifest.queries.map((q) => q.caseId))) {
    const phases = manifest.queries.filter((q) => q.caseId === caseId).map((q) => q.phase);
    assert.ok(phases.includes('primary'));
    assert.ok(phases.includes('coverage'));
  }
  assert.ok(
    manifest.queries.some((q) => q.caseId === 'primary-empty-retry' && q.phase === 'retry'),
  );
  const fixture = syntheticChatArtifactFixture();
  const json = JSON.stringify(fixture);
  const { input, provenance } = parseParityChatArtifact(json);
  assert.equal(provenance.checksum, parityChatTextHash(json));
  for (const entry of fixture.queries) {
    const get = () => input.chatVector(entry.caseId, entry.projectId, entry.phase, entry.text);
    assert.deepEqual(get(), entry.values);
    get().fill(0);
    assert.deepEqual(get(), entry.values);
  }
  assert.throws(
    () => input.chatVector('unknown', 'alpha', 'primary', 'private text'),
    /^Error: Unknown Chat embedding artifact input$/,
  );
  assert.throws(
    () => input.chatVector('chat-design', 'foreign', 'primary', 'private text'),
    /Unknown/,
  );
  assert.throws(() => parseParityEmbeddingArtifact(json), /Invalid/);
  fixture.retrieval.embedding.mode = 'real';
  const real = parseParityChatArtifact(JSON.stringify(fixture));
  assert.equal(real.provenance.originVerified, false);
  assert.equal(real.provenance.semanticQualityMeasured, false);
});

test('bundle rejects missing, extra, duplicate, changed identities/text/hash and inconsistent vectors', () => {
  const mutations: ((v: ReturnType<typeof syntheticChatArtifactFixture>) => void)[] = [
    (v) => {
      v.version = 'unknown';
    },
    (v) => {
      v.schemaHash = 'unknown';
    },
    (v) => {
      v.planVersion = 'unknown';
    },
    (v) => {
      v.queries.pop();
    },
    (v) => {
      v.retrieval.chunks.pop();
    },
    (v) => {
      v.queries.push(structuredClone(first(v.queries)));
    },
    (v) => {
      v.queries[1] = structuredClone(first(v.queries));
    },
    (v) => {
      first(v.queries).text += ' private text';
    },
    (v) => {
      first(v.queries).textHash = 'bad';
    },
    (v) => {
      first(v.queries).caseId = 'unknown';
    },
    (v) => {
      first(v.queries).projectId = 'beta';
    },
    (v) => {
      first(v.queries).phase = 'coverage';
    },
    (v) => {
      first(v.queries).values.fill(0);
    },
    (v) => {
      first(v.queries).values.pop();
    },
    (v) => {
      first(v.queries).values[0] = 1e100;
    },
    (v) => {
      first(v.queries).values[0] = 0.123456789;
    },
  ];
  for (const mutate of mutations) {
    const fixture = syntheticChatArtifactFixture();
    mutate(fixture);
    assert.throws(
      () => parseParityChatArtifact(JSON.stringify(fixture)),
      /^Error: Invalid (Chat )?embedding artifact/,
    );
  }
  assert.throws(
    () => parseParityChatArtifact('private text'),
    /^Error: Invalid Chat embedding artifact$/,
  );
});
