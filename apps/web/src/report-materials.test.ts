import assert from 'node:assert/strict';
import {
  editReportMaterials,
  REPORT_MATERIAL_GROUP_LIMIT,
  REPORT_REPRESENTATIVE_LIMIT,
} from './report-materials.ts';
import type { ReportDocumentRecord } from './report-repository.ts';

function document(index: number, input: Partial<ReportDocumentRecord> = {}): ReportDocumentRecord {
  return {
    canonicalUri: `https://example.com/documents/${index}`,
    docType: 'web_page',
    documentId: `doc-${index}`,
    occurredAt: new Date(Date.UTC(2026, 6, 15) - index * 60_000).toISOString(),
    rawDocumentId: `raw-${index}`,
    summary: `Context material ${index}`,
    title: `Document ${index}`,
    ...input,
  };
}

const smallInput = [document(0), document(1), document(2)];
assert.deepEqual(
  editReportMaterials(smallInput).representativeDocuments.map((item) => item.documentId),
  smallInput.map((item) => item.documentId),
);

const nullableSummary = document(3, { summary: null as never });
assert.doesNotMatch(
  editReportMaterials([nullableSummary]).materialGroups[0]?.markdown ?? '',
  /undefined|null/,
);

const largeInput = Array.from({ length: 40 }, (_, index) => document(index));
largeInput[31] = document(31, {
  docType: 'issue',
  summary: 'Critical migration risk beyond the former cutoff',
});
largeInput[32] = document(32, {
  docType: 'pull_request',
  summary: 'Authentication policy was approved and selected',
});
largeInput[33] = document(33, {
  docType: 'meeting_note',
  summary: 'The release implementation was completed',
});

const edited = editReportMaterials(largeInput);
assert.equal(edited.totalDocumentCount, 40);
assert.equal(edited.representativeDocuments.length, REPORT_REPRESENTATIVE_LIMIT);
assert.ok(edited.representativeDocuments.some((item) => item.documentId === 'doc-31'));
assert.ok(edited.representativeDocuments.some((item) => item.documentId === 'doc-32'));
assert.ok(edited.representativeDocuments.some((item) => item.documentId === 'doc-33'));
assert.ok(edited.representativeDocuments.some((item) => item.documentId === 'doc-39'));
assert.deepEqual(
  edited.materialGroups.map((group) => group.role),
  ['decision', 'risk', 'progress', 'context'],
);
assert.equal(
  edited.materialGroups.reduce((count, group) => count + group.documentCount, 0),
  largeInput.length,
);
assert.match(
  edited.materialGroups.map((group) => group.markdown).join('\n'),
  /Critical migration risk beyond the former cutoff/,
);
assert.deepEqual(
  new Set(edited.materialGroups.flatMap((group) => group.documentIds)),
  new Set(largeInput.map((item) => item.documentId)),
);

const overflowContextInput = Array.from({ length: REPORT_MATERIAL_GROUP_LIMIT + 12 }, (_, index) =>
  document(index),
);
const overflowContextEdited = editReportMaterials(overflowContextInput);
const contextGroup = overflowContextEdited.materialGroups.find((group) => group.role === 'context');
assert.ok(contextGroup);
assert.equal(contextGroup.documentCount, REPORT_MATERIAL_GROUP_LIMIT);
assert.equal(contextGroup.documentIds.length, REPORT_MATERIAL_GROUP_LIMIT);
assert.equal(contextGroup.markdown.split('\n').length, REPORT_MATERIAL_GROUP_LIMIT);
assert.equal(overflowContextEdited.totalDocumentCount, overflowContextInput.length);
