import assert from 'node:assert/strict';
import type { GraphViewerEdge, GraphViewerNode } from './graph-viewer.ts';
import { buildTimelinePositions, graphNodeSortValue } from './graph-viewer-layout.ts';

const olderDocument = node('doc-old', 'Older Document', {
  created_at: '2026-07-09T00:00:00.000Z',
  occurred_at: '2026-07-01T00:00:00.000Z',
});
const newerDocument = node('doc-new', 'Newer Document', {
  occurred_at: '2026-07-03T00:00:00.000Z',
});
const middleDocument = node('doc-middle', 'Middle Document', {
  occurredAt: '2026-07-02T00:00:00.000Z',
});
const actorWithoutDate = node('actor-a', 'Actor A', {});
const undatedNeighbor = node('undated-neighbor', 'Y Undated Neighbor', {});
const undatedTail = node('undated-tail', 'Z Undated Tail', {});

assert.equal(graphNodeSortValue(olderDocument), Date.parse('2026-07-01T00:00:00.000Z'));

const positions = buildTimelinePositions(
  [newerDocument, actorWithoutDate, olderDocument, middleDocument],
  [edge('edge-a', actorWithoutDate.id, middleDocument.id)],
);

assert.ok(
  requiredPosition(positions, olderDocument.id).x <
    requiredPosition(positions, middleDocument.id).x,
);
assert.ok(
  requiredPosition(positions, middleDocument.id).x <
    requiredPosition(positions, actorWithoutDate.id).x,
);
assert.ok(
  requiredPosition(positions, actorWithoutDate.id).x <
    requiredPosition(positions, newerDocument.id).x,
);

assert.equal(graphNodeSortValue(undatedTail), undefined);

const undatedPositions = buildTimelinePositions(
  [undatedTail, newerDocument, olderDocument, undatedNeighbor],
  [edge('edge-undated', undatedTail.id, undatedNeighbor.id)],
);

assert.ok(
  requiredPosition(undatedPositions, newerDocument.id).x <
    requiredPosition(undatedPositions, undatedNeighbor.id).x,
);
assert.ok(
  requiredPosition(undatedPositions, undatedNeighbor.id).x <
    requiredPosition(undatedPositions, undatedTail.id).x,
);

console.log('web graph viewer layout tests passed');

function node(id: string, label: string, properties: Record<string, unknown>): GraphViewerNode {
  return {
    id,
    label,
    labels: ['Document'],
    properties,
  };
}

function edge(id: string, source: string, target: string): GraphViewerEdge {
  return {
    id,
    label: 'MENTIONS',
    properties: {},
    source,
    target,
  };
}

function requiredPosition(
  positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>,
  nodeId: string,
) {
  const position = positions.get(nodeId);
  assert.ok(position, `Missing position for ${nodeId}`);
  return position;
}
