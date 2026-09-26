import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syntheticEmbeddingArtifactFixture } from '../../../scripts/lib/parity-embedding-artifact.fixture.ts';
import { parityFixture } from '../../../scripts/lib/parity-fixture.ts';
import { runLocalParity } from '../parity-local.mjs';

test('saved synthetic artifact drives real DB candidates/RRF without quality or Chat promotion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parity-artifact-'));
  try {
    const fixture = syntheticEmbeddingArtifactFixture();
    const path = join(directory, 'input.json');
    await writeFile(path, JSON.stringify(fixture));
    const report = await runLocalParity(
      join(directory, 'report'),
      process.env.KEYWORD_EVAL_DATABASE_URL,
      path,
    );
    const evidence = report.localEvidence.artifactRetrieval;
    assert.equal(report.qualityGate, false);
    assert.equal(report.step7Gate, 'not-evaluated');
    assert.equal(report.localEvidence.syntheticRetrieval, null);
    assert.equal(report.localEvidence.syntheticChat, null);
    assert.equal(evidence.provenance.declaredEmbedding.mode, 'synthetic');
    assert.equal(evidence.provenance.originVerified, false);
    assert.equal(evidence.cloudflare.storedVectors, 37);
    assert.equal(evidence.cloudflare.fakeCalls.query, 6);
    for (const result of [evidence.cloudflare, evidence.gcp].filter(Boolean)) {
      assert.equal(result.inputHash, evidence.provenance.checksum);
      assert.equal(result.rows.length, 6);
      assert.ok(result.rows.every((row) => row.chunkIds.length === 10 && row.scopePass));
      assert.ok(
        result.rows
          .filter((row) => row.id.startsWith('hybrid'))
          .every((row) => row.finalDocumentIds.length > 0),
      );
      assert.equal(result.qualityGate, false);
    }
    if (process.env.KEYWORD_EVAL_DATABASE_URL) {
      assert.ok(evidence.gcp);
      assert.deepEqual(evidence.gcp.rows, evidence.cloudflare.rows);
    }
    const snapshot = JSON.parse(await readFile(join(directory, 'report/cloudflare.json'), 'utf8'));
    assert.equal(snapshot.rows.length, 39);
    const json = JSON.stringify(report);
    for (const chunk of parityFixture.chunks) assert.equal(json.includes(chunk.content), false);
    for (const query of fixture.queries)
      assert.equal(json.includes(JSON.stringify(query.values)), false);
    for (const query of parityFixture.cases.filter((c) => c.kind === 'semantic'))
      assert.equal(json.includes(query.query), false);
    // Deliberately false self-declaration must not promote these synthetic vectors.
    fixture.embedding.mode = 'real';
    await writeFile(path, JSON.stringify(fixture));
    const declaredReal = await runLocalParity(join(directory, 'declared-real'), undefined, path);
    assert.equal(declaredReal.qualityGate, false);
    assert.equal(declaredReal.localEvidence.artifactRetrieval.provenance.originVerified, false);
    assert.equal(
      declaredReal.localEvidence.artifactRetrieval.provenance.semanticQualityMeasured,
      false,
    );
    assert.equal(
      declaredReal.localEvidence.artifactRetrieval.cloudflare.vectorize,
      'fake-exact-cosine',
    );
    assert.equal(declaredReal.localEvidence.syntheticChat, null);
    const declaredSnapshot = JSON.parse(
      await readFile(join(directory, 'declared-real/cloudflare.json'), 'utf8'),
    );
    assert.equal(declaredSnapshot.rows.length, 39);
    assert.equal(declaredSnapshot.metadata.embedding.mode, 'synthetic');
    fixture.chunks.pop();
    await writeFile(path, JSON.stringify(fixture));
    await assert.rejects(
      runLocalParity(join(directory, 'invalid'), 'postgres://remote.invalid/keyword_eval', path),
      /artifact coverage/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
