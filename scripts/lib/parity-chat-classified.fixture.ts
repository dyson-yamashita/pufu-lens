import assert from 'node:assert/strict';
import type { collectSyntheticChat } from './parity-chat.ts';

/** Checks the same observed real-DB dataflow on PostgreSQL and D1, without supplying candidates. */
export function assertClassifiedPriority(
  evidence: Awaited<ReturnType<typeof collectSyntheticChat>>['classifiedPriority'],
) {
  assert.equal(evidence.version, 'chat-classified-priority-v1');
  assert.equal(evidence.qualityGate, false);
  const find = (id: string) => {
    const row = evidence.observations.find((row) => row.id === id);
    assert.ok(row);
    return row;
  };
  const full = find('classified-full');
  const boundary = full.finalSelectionBoundary;
  assert.equal(boundary.classification, 'cause');
  assert.equal(boundary.prioritizeGraphSupplement, true);
  assert.equal(boundary.documentLimit, 2);
  assert.deepEqual(boundary.beforeDocumentIds, ['d09', 'd01']);
  assert.deepEqual(boundary.afterDocumentIds, ['d09', 'd02']);
  assert.deepEqual(boundary.removedDocumentIds, ['d01']);
  assert.deepEqual(boundary.addedDocumentIds, ['d02']);
  assert.deepEqual(boundary.graphOnlyDocumentIds, ['d02']);
  assert.equal(boundary.outcome, 'replacement');
  assert.equal(boundary.priorityReplacementMeasured, true);
  assert.equal(full.retry.executed, false);
  assert.deepEqual(full.documentReads[0]?.requested, ['d09', 'd01']);
  assert.deepEqual(full.documentReads[0]?.databaseReturned.toSorted(), ['d01', 'd09']);
  assert.ok(full.graphReads[0]?.relations.some((r) => r.join() === 'd01,SAME_AS,d02,1'));
  assert.deepEqual(boundary.finalSources.find((s) => s.documentId === 'd02')?.internalKeys, [
    'hopCount',
    'relationType',
    'seedDocumentId',
  ]);
  assert.equal(full.graphMetadataAtFinalSelection, true);
  const quota = find('classified-quota');
  assert.deepEqual(quota.finalSelectionBoundary.beforeDocumentIds, ['d09']);
  assert.equal(quota.finalSelectionBoundary.outcome, 'addition');
  const single = find('classified-single');
  assert.equal(single.finalSelectionBoundary.outcome, 'unchanged');
  assert.equal(single.finalGraphDiagnostics.sourceLimitExcluded, 1);
  const room = find('classified-room');
  assert.equal(room.finalSelectionBoundary.outcome, 'addition');
  // Preserve the real duplicate; this harness must not repair production policy.
  assert.deepEqual(room.finalDocumentIds, ['d01', 'd02', 'd02']);
  assert.deepEqual(room.finalSelectionBoundary.addedDocumentIds, ['d02']);
  const retry = find('classified-retry');
  assert.equal(retry.retry.executed, true);
  assert.equal(retry.hybridReads.filter((read) => read.phase === 'retry').length, 1);
  assert.ok(retry.retry.afterDocumentIds.length > 0);
  assert.deepEqual(retry.finalSelectionBoundary.graphOnlyDocumentIds, []);
  assert.equal(retry.finalSelectionBoundary.outcome, 'unchanged');
  for (const row of evidence.observations) {
    assert.equal(row.finalSelectionBoundary.priorityReplacementMeasured, row === full);
    assert.equal(row.detailControl, null);
    assert.equal(row.sourceRedactionPass, true);
    assert.equal(row.workflowHttpRequests, 2);
    assert.equal(row.rubricPass, null);
    assert.equal(row.criticalErrorsMeasured, false);
    for (const read of row.hybridReads) {
      assert.ok(read.returnedDocumentIds.every((id) => read.adapterDocumentIds.includes(id)));
      if (read.phase !== 'primary')
        assert.deepEqual(read.returnedDocumentIds, read.adapterDocumentIds);
    }
    for (const read of row.documentReads) assert.deepEqual(read.returned, read.databaseReturned);
  }
}
