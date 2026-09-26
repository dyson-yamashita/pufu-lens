import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertClassifiedPriority } from '../../../scripts/lib/parity-chat-classified.fixture.ts';
import { parseParityRun } from '../../../scripts/lib/parity-eval.ts';
import { runLocalParity } from '../parity-local.mjs';

test('real workerd keyword/Graph runner preserves observations and missing capabilities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parity-local-'));
  try {
    const report = await runLocalParity(directory, undefined);
    const snapshot = parseParityRun(
      JSON.parse(await readFile(join(directory, 'cloudflare.json'), 'utf8')),
    );
    assert.equal(snapshot.rows.length, 39);
    assert.equal(report.localEvidence.cloudflare.missing.length, 13);
    assert.equal(report.localEvidence.gcp.missing.length, 52);
    assert.equal(report.qualityGate, false);
    assert.equal(report.comparisonComplete, false);
    const synthetic = report.localEvidence.syntheticRetrieval;
    assert.equal(synthetic.gcp, null);
    assert.equal(synthetic.cloudflare.snapshot.rows.length, 6);
    assert.equal(synthetic.cloudflare.snapshot.metadata.embedding.mode, 'synthetic');
    assert.equal(synthetic.cloudflare.qualityGate, false);
    assert.equal(synthetic.cloudflare.vectorize, 'fake-exact-cosine');
    assert.equal(report.localEvidence.syntheticChat.gcp, null);
    assert.equal(report.localEvidence.syntheticChat.cloudflare.snapshot.rows.length, 3);
    assert.equal(report.localEvidence.syntheticChat.cloudflare.qualityGate, false);
    const chat = report.localEvidence.syntheticChat.cloudflare;
    assertClassifiedPriority(chat.classifiedPriority);
    assert.ok(chat.observations.every((row) => !row.retry.decision && !row.retry.executed));
    assert.ok(chat.observations.every((row) => row.finalGraphDocumentIds.length === 0));
    assert.deepEqual(chat.observations[0].graphExcludedFromFinalDocumentIds, ['d02']);
    const retry = chat.controlled.observations.find((row) => row.id === 'primary-empty-retry');
    assert.equal(retry.retry.executed, true);
    assert.equal(retry.hybridReads.filter((read) => read.phase === 'retry').length, 1);
    assert.ok(retry.retry.afterDocumentIds.length > 0);
    assert.ok(retry.graphReads[0].relations.some((tuple) => tuple[1] === 'RELATED_TO'));
    const graph = chat.controlled.observations.find((row) => row.id === 'single-seed-graph-final');
    assert.deepEqual(graph.graphReads[0].seeds, ['d01']);
    assert.deepEqual(graph.graphAdoptedDocumentIds, ['d02']);
    assert.deepEqual(graph.finalGraphDocumentIds, ['d02']);
    assert.deepEqual(graph.finalDocumentIds, ['d01', 'd02']);
    assert.equal(graph.graphMetadataAtFinalSelection, false);
    assert.equal(graph.sourceRedactionPass, true);
    assert.equal(graph.workflowHttpRequests, 2);
    assert.equal(chat.controlled.qualityGate, false);
    assert.equal(
      report.localEvidence.syntheticChat.cloudflare.staleRead.actualError,
      'unavailable',
    );
    assert.equal(report.localEvidence.sharedChatFailures.observations.length, 3);
    assert.ok(
      snapshot.rows.every(
        (row) => !row.id.startsWith('semantic-') && !row.id.startsWith('hybrid-'),
      ),
    );
    assert.equal(snapshot.rows.find((row) => row.id === 'keyword-over-length')?.error, 'rejected');
    assert.ok(snapshot.rows.every((row) => row.scopePass));
    assert.ok(
      snapshot.rows
        .filter((r) => r.id.startsWith('keyword-'))
        .every((row) => row.mutationPass === null),
    );
    assert.ok(
      snapshot.rows
        .filter((r) => r.id.startsWith('mutation-'))
        .every((row) => row.mutationPass === true),
    );
    assert.deepEqual(snapshot.rows.find((r) => r.id === 'graph-MENTIONS').graph, []);
    for (const observation of report.localEvidence.cloudflare.graphObservations) {
      assert.equal(observation.sentinelUnchanged, true);
      assert.equal(observation.foreignSeedRejected, true);
      if (observation.id.startsWith('mutation-')) assert.equal(observation.retryStable, true);
    }
    assert.ok(snapshot.rows.some((row) => row.chunkIds.length > 0));
    assert.equal(snapshot.metadata.embedding.mode, 'synthetic');
    const serialized = await readFile(join(directory, 'report.json'), 'utf8');
    assert.equal(serialized.includes('normalizedQuery'), false);
    assert.equal(serialized.includes('content'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
