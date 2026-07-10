import type { GraphViewerEdge, GraphViewerNode } from './graph-viewer';

const TIMELINE_COLUMN_WIDTH = 180;
const TIMELINE_ROW_HEIGHT = 170;
const TIMELINE_ALTERNATE_OFFSET = 48;

export type GraphTimelinePosition = {
  readonly x: number;
  readonly y: number;
};

/**
 * Assigns timeline layout positions to graph nodes.
 *
 * Nodes with their own date are positioned left-to-right by occurredAt/occurred_at first.
 * Undated nodes inherit the nearest connected dated node's timeline position when possible.
 *
 * @param nodes - The nodes to position.
 * @param edges - The edges used to cluster undated nodes near dated neighbors.
 * @returns A map from node ID to its timeline position.
 */
export function buildTimelinePositions(
  nodes: readonly GraphViewerNode[],
  edges: readonly GraphViewerEdge[],
): Map<string, GraphTimelinePosition> {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = buildTimelineAdjacency(edges, nodesById);
  const nodeDates = new Map<string, number>();
  for (const node of nodes) {
    const sortValue = graphNodeSortValue(node);
    if (sortValue !== undefined) {
      nodeDates.set(node.id, sortValue);
    }
  }
  const connectedSortValues = buildConnectedTimelineSortValues(nodes, adjacency, nodeDates);

  const orderedNodes = nodes
    .map((node, index) => ({
      index,
      node,
      sortValue: nodeDates.get(node.id) ?? connectedSortValues.get(node.id),
    }))
    .sort((left, right) => {
      const leftSort = left.sortValue ?? Number.POSITIVE_INFINITY;
      const rightSort = right.sortValue ?? Number.POSITIVE_INFINITY;
      if (leftSort !== rightSort) {
        return leftSort - rightSort;
      }
      const leftHasDate = nodeDates.has(left.node.id);
      const rightHasDate = nodeDates.has(right.node.id);
      if (leftHasDate !== rightHasDate) {
        return leftHasDate ? -1 : 1;
      }
      return left.node.label.localeCompare(right.node.label) || left.index - right.index;
    });

  const laneUsage = new Map<number, number>();
  const positions = new Map<string, GraphTimelinePosition>();
  orderedNodes.forEach(({ node }, index) => {
    const timestamp = nodeDates.get(node.id) ?? connectedSortValues.get(node.id);
    const laneKey = timestamp ?? Number.POSITIVE_INFINITY;
    const lane = laneUsage.get(laneKey) ?? 0;
    laneUsage.set(laneKey, lane + 1);
    positions.set(node.id, {
      x: index * TIMELINE_COLUMN_WIDTH,
      y: lane * TIMELINE_ROW_HEIGHT + (index % 2 === 0 ? 0 : TIMELINE_ALTERNATE_OFFSET),
    });
  });

  return positions;
}

/**
 * Produces a sort value from a node's date-related properties.
 *
 * @returns A numeric timestamp when a supported property contains a finite number or a parseable date string, or `undefined` when no suitable value is found.
 */
export function graphNodeSortValue(node: GraphViewerNode): number | undefined {
  for (const key of [
    'occurredAt',
    'occurred_at',
    'createdAt',
    'created_at',
    'updatedAt',
    'updated_at',
    'publishedAt',
    'published_at',
    'collectedAt',
    'collected_at',
    'timestamp',
    'date',
  ]) {
    const value = node.properties[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) {
        return timestamp;
      }
    }
  }
  return undefined;
}

function buildTimelineAdjacency(
  edges: readonly GraphViewerEdge[],
  nodesById: ReadonlyMap<string, GraphViewerNode>,
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) {
      continue;
    }
    appendTimelineNeighbor(adjacency, edge.source, edge.target);
    appendTimelineNeighbor(adjacency, edge.target, edge.source);
  }
  return adjacency;
}

function appendTimelineNeighbor(
  adjacency: Map<string, string[]>,
  nodeId: string,
  neighborId: string,
): void {
  const neighbors = adjacency.get(nodeId);
  if (neighbors) {
    neighbors.push(neighborId);
    return;
  }
  adjacency.set(nodeId, [neighborId]);
}

function buildConnectedTimelineSortValues(
  nodes: readonly GraphViewerNode[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  nodeDates: ReadonlyMap<string, number>,
): Map<string, number> {
  const connectedSortValues = new Map<string, number>();
  for (const node of nodes) {
    if (nodeDates.has(node.id)) {
      continue;
    }
    const connectedDates = (adjacency.get(node.id) ?? [])
      .map((connectedId) => nodeDates.get(connectedId))
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => left - right);
    if (connectedDates.length > 0) {
      connectedSortValues.set(
        node.id,
        connectedDates[Math.floor((connectedDates.length - 1) / 2)] as number,
      );
    }
  }
  return connectedSortValues;
}
