import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePresetRows } from './postgres-relational-read-preset.js';

const DEFAULT_LIMITS = {
  maxEdges: 500,
  maxNodes: 600,
  queryLimit: 501,
} as const;

function presetQueryRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    edgeLabel: 'AUTHORED',
    edgeProperties: { actorId: '71400000-0000-0000-0000-000000000010' },
    edgeSource: 'actor:issue-714-a',
    edgeTarget: 'document:issue-714-b',
    sourceKind: 'actor',
    sourceNodeKey: 'actor:issue-714-a',
    sourceProperties: {
      actorId: '71400000-0000-0000-0000-000000000010',
      displayName: 'Actor A',
      graphLabels: ['Actor'],
      graphNodeId: 'actor:issue-714-a',
    },
    targetKind: 'document',
    targetNodeKey: 'document:issue-714-b',
    targetProperties: {
      docType: 'web_page',
      documentId: '71400000-0000-0000-0000-000000000020',
      graphLabels: ['Document'],
      graphNodeId: 'document:issue-714-b',
    },
    ...overrides,
  };
}

function assertEdgeEndpointsExistInNodes(normalized: ReturnType<typeof normalizePresetRows>): void {
  const nodeIds = new Set(normalized.result.nodes.map((node) => node.id));
  for (const edge of normalized.result.edges) {
    assert.ok(nodeIds.has(edge.source), `missing edge source node: ${edge.source}`);
    assert.ok(nodeIds.has(edge.target), `missing edge target node: ${edge.target}`);
  }
}

test('normalizePresetRows rejects non-record SQL rows fail-closed', () => {
  assert.throws(
    () => normalizePresetRows([null], DEFAULT_LIMITS),
    /Invalid relational preset query row/,
  );
});

test('normalizePresetRows skips rows that exceed node limits without dangling edges', () => {
  const normalized = normalizePresetRows([presetQueryRow()], {
    maxEdges: 10,
    maxNodes: 1,
    queryLimit: 10,
  });
  assert.equal(normalized.result.nodes.length, 0);
  assert.equal(normalized.result.edges.length, 0);
  assert.equal(normalized.rawRows.length, 0);
  assert.equal(normalized.result.truncated, true);
  assertEdgeEndpointsExistInNodes(normalized);
});

test('normalizePresetRows keeps bounded rows and truncates overflow without dangling edges', () => {
  const normalized = normalizePresetRows(
    [
      presetQueryRow(),
      presetQueryRow({
        edgeSource: 'actor:issue-714-c',
        edgeTarget: 'document:issue-714-d',
        sourceNodeKey: 'actor:issue-714-c',
        targetNodeKey: 'document:issue-714-d',
        sourceProperties: {
          actorId: '71400000-0000-0000-0000-000000000011',
          displayName: 'Actor C',
          graphLabels: ['Actor'],
          graphNodeId: 'actor:issue-714-c',
        },
        targetProperties: {
          docType: 'email',
          documentId: '71400000-0000-0000-0000-000000000021',
          graphLabels: ['Document'],
          graphNodeId: 'document:issue-714-d',
        },
      }),
    ],
    {
      maxEdges: 10,
      maxNodes: 2,
      queryLimit: 10,
    },
  );
  assert.equal(normalized.result.nodes.length, 2);
  assert.equal(normalized.result.edges.length, 1);
  assert.equal(normalized.rawRows.length, 1);
  assert.equal(normalized.result.truncated, true);
  assertEdgeEndpointsExistInNodes(normalized);
});

test('normalizePresetRows does not treat duplicate edges as maxEdges overflow', () => {
  const duplicateRow = presetQueryRow();
  const normalized = normalizePresetRows([duplicateRow, duplicateRow], {
    maxEdges: 1,
    maxNodes: 10,
    queryLimit: 10,
  });
  assert.equal(normalized.result.edges.length, 1);
  assert.equal(normalized.result.nodes.length, 2);
  assert.equal(normalized.rawRows.length, 2);
  assert.equal(normalized.result.truncated, false);
  assertEdgeEndpointsExistInNodes(normalized);
});
