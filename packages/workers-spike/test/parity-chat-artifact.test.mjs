import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectArtifactChat } from '../../../scripts/lib/parity-chat.ts';
import { parseParityChatArtifact } from '../../../scripts/lib/parity-chat-artifact.ts';
import { syntheticChatArtifactFixture } from '../../../scripts/lib/parity-embedding-artifact.fixture.ts';
import { parityFixture } from '../../../scripts/lib/parity-fixture.ts';
import { withPostgresParityCandidates } from '../../../scripts/lib/parity-retrieval-postgres.ts';
import { runLocalParity } from '../parity-local.mjs';
import { withD1ParityCandidates } from '../parity-retrieval-local.mjs';

test('explicit saved text-projection fixture exercises Graph final adoption without runtime fallback', async () => {
  const { input } = parseParityChatArtifact(
    JSON.stringify(syntheticChatArtifactFixture('default-text')),
  );
  const collect = (repositories, database) => collectArtifactChat(repositories, database, input);
  const d1 = await withD1ParityCandidates(
    (repositories, _fault, database) => collect(repositories, database),
    input,
  );
  const pg = process.env.KEYWORD_EVAL_DATABASE_URL
    ? await withPostgresParityCandidates(process.env.KEYWORD_EVAL_DATABASE_URL, collect, input)
    : null;
  for (const result of [d1, pg].filter(Boolean)) {
    const graph = result.controlled.observations.find(
      (row) => row.id === 'single-seed-graph-final',
    );
    assert.deepEqual(graph.graphReads[0].seeds, ['d01']);
    assert.deepEqual(graph.finalGraphDocumentIds, ['d02']);
    assert.deepEqual(graph.finalDocumentIds, ['d01', 'd02']);
    assert.equal(graph.sourceRedactionPass, true);
    assert.equal(graph.retry.executed, false);
    assert.equal(graph.graphMetadataAtFinalSelection, false);
    const boundary = result.finalSourceBoundary;
    assert.equal(boundary.version, 'chat-final-source-boundary-v1');
    assert.equal(boundary.qualityGate, false);
    const missing = boundary.observations[0];
    // The same saved query identity, actual ranking, Graph relation and retry decision are
    // replayed; only the real document reader's d02 result is removed after it was observed.
    assert.equal(missing.id, graph.id);
    assert.deepEqual(missing.embeddingReads, graph.embeddingReads);
    assert.deepEqual(missing.hybridReads, graph.hybridReads);
    assert.deepEqual(missing.graphReads, graph.graphReads);
    assert.deepEqual(missing.retry, graph.retry);
    assert.deepEqual(missing.documentReads[0].databaseReturned.slice().sort(), ['d01', 'd02']);
    assert.deepEqual(missing.documentReads[0].returned, ['d01']);
    assert.deepEqual(missing.finalDocumentIds, graph.finalDocumentIds);
    assert.deepEqual(missing.finalGraphDocumentIds, ['d02']);
    assert.equal(missing.graphMetadataAtFinalSelection, true);
    assert.deepEqual(
      missing.finalSelectionBoundary.finalSources.find((s) => s.documentId === 'd02').internalKeys,
      ['hopCount', 'relationType', 'seedDocumentId'],
    );
    assert.equal(missing.sourceRedactionPass, true);
    assert.equal(missing.workflowHttpRequests, 2);
    for (const row of [...result.observations, ...result.controlled.observations, missing]) {
      assert.equal(row.finalSelectionBoundary.classification, 'general');
      assert.equal(row.finalSelectionBoundary.prioritizeGraphSupplement, false);
      assert.equal(row.finalSelectionBoundary.priorityReplacementMeasured, false);
    }
    assert.deepEqual(result.stubs, ['loopback-synthesis']);
    const retry = result.controlled.observations.find((row) => row.id === 'primary-empty-retry');
    assert.equal(retry.retry.executed, true);
    assert.ok(retry.graphReads[0].relations.some((row) => row[1] === 'RELATED_TO'));
  }
  if (pg) assert.deepEqual(pg.rows, d1.rows);
});

test('saved Chat vectors drive fixed steps on real DBs and remain separate from quality', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parity-chat-artifact-'));
  try {
    const fixture = syntheticChatArtifactFixture();
    const path = join(directory, 'input.json');
    await writeFile(path, JSON.stringify(fixture));
    const report = await runLocalParity(
      join(directory, 'report'),
      process.env.KEYWORD_EVAL_DATABASE_URL,
      undefined,
      path,
    );
    const artifact = report.localEvidence.artifactChat;
    assert.equal(report.qualityGate, false);
    assert.equal(report.step7Gate, 'not-evaluated');
    assert.equal(report.localEvidence.syntheticChat, null);
    assert.equal(report.localEvidence.syntheticRetrieval, null);
    assert.equal(artifact.provenance.declaredEmbedding.mode, 'synthetic');
    assert.equal(artifact.provenance.originVerified, false);
    assert.equal(artifact.cloudflare.storedVectors, 37);
    const compact = (run) =>
      [
        ...run.observations,
        ...run.controlled.observations,
        ...run.finalSourceBoundary.observations,
      ].map(({ latencyMs: _, ...row }) => row);
    for (const run of [artifact.gcp, artifact.cloudflare].filter(Boolean)) {
      assert.equal('classifiedPriority' in run, false);
      assert.equal(run.inputHash, artifact.provenance.checksum);
      assert.equal(run.rows.length, 3);
      assert.equal(run.controlled.observations.length, 2);
      assert.equal(run.qualityGate, false);
      assert.deepEqual(run.stubs, ['loopback-synthesis']);
      for (const row of compact(run)) {
        assert.equal(row.sourceRedactionPass, true);
        assert.equal(row.workflowHttpRequests, 2);
        assert.equal(row.rubricPass, null);
        assert.equal(row.criticalErrorsMeasured, false);
        for (const read of row.embeddingReads)
          for (const textHash of read.textHashes)
            assert.ok(
              fixture.queries.some(
                (q) =>
                  q.caseId === row.id &&
                  q.projectId === row.input.projectId &&
                  q.phase === read.phase &&
                  q.textHash === textHash,
              ),
            );
        assert.ok(row.documentReads.length > 0);
      }
      const retry = run.controlled.observations.find((row) => row.id === 'primary-empty-retry');
      assert.equal(retry.retry.executed, true);
      assert.ok(retry.retry.afterDocumentIds.length > 0);
      assert.equal(retry.hybridReads.filter((read) => read.phase === 'retry').length, 1);
      const missing = run.finalSourceBoundary.observations[0];
      // This projection does not retrieve d01 initially. Keep the failed control and real retry,
      // rather than inserting a Graph source to satisfy the probe's name.
      assert.equal(missing.retry.executed, true);
      assert.deepEqual(missing.hybridReads[0].returnedDocumentIds, []);
      assert.deepEqual(missing.finalGraphDocumentIds, []);
      assert.equal(missing.graphMetadataAtFinalSelection, false);
    }
    if (process.env.KEYWORD_EVAL_DATABASE_URL) {
      assert.ok(artifact.gcp);
      assert.deepEqual(artifact.gcp.rows, artifact.cloudflare.rows);
      // SQL hydration order is not a contract; compare the step outputs and vector reads.
      const outputs = (run) =>
        compact(run).map((row) => ({
          id: row.id,
          embeddingReads: row.embeddingReads,
          hybridReads: row.hybridReads,
          retry: row.retry,
          finalDocumentIds: row.finalDocumentIds,
          graphAdoptedDocumentIds: row.graphAdoptedDocumentIds,
          finalGraphDocumentIds: row.finalGraphDocumentIds,
        }));
      assert.deepEqual(outputs(artifact.gcp), outputs(artifact.cloudflare));
    }
    const json = JSON.stringify(report);
    assert.equal(json.includes(path), false);
    for (const query of fixture.queries) {
      assert.equal(json.includes(query.text), false);
      assert.equal(json.includes(JSON.stringify(query.values)), false);
    }
    for (const chunk of parityFixture.chunks) assert.equal(json.includes(chunk.content), false);
    fixture.retrieval.embedding.mode = 'real';
    await writeFile(path, JSON.stringify(fixture));
    const real = await runLocalParity(join(directory, 'real'), undefined, undefined, path);
    assert.equal(real.qualityGate, false);
    assert.equal(real.localEvidence.artifactChat.provenance.originVerified, false);
    assert.equal(real.localEvidence.artifactChat.provenance.semanticQualityMeasured, false);
    const snapshot = JSON.parse(await readFile(join(directory, 'real/cloudflare.json'), 'utf8'));
    assert.equal(snapshot.rows.length, 39);
    assert.equal(snapshot.metadata.embedding.mode, 'synthetic');
    fixture.queries.pop();
    await writeFile(path, JSON.stringify(fixture));
    await assert.rejects(
      runLocalParity(
        join(directory, 'invalid'),
        'postgres://remote.invalid/keyword_eval',
        undefined,
        path,
      ),
      /Invalid Chat embedding artifact/,
    );
    await assert.rejects(runLocalParity(directory, undefined, path, path), /exactly one/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
