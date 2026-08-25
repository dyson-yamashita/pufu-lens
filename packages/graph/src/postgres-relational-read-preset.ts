import { createHash } from 'node:crypto';
import type { GraphPresetReadResult, GraphReadEdge, GraphReadNode } from './index.js';
import {
  displayNodeLabel,
  isRecord,
  nodeLabelsFromProperties,
  propertyString,
  requireNonEmptyString,
  requireRecord,
  safeJsonPreview,
} from './postgres-relational-common.js';

export const GRAPH_PRESET_MAX_EDGES = 500;
export const GRAPH_PRESET_MAX_NODES = 600;

export interface RelationalGraphReadRow {
  readonly edge?: GraphReadEdge;
  readonly node: GraphReadNode;
}

/** Parses a bounded relational preset row at the adapter boundary. */
export function parseRelationalGraphReadRow(row: unknown, label: string): RelationalGraphReadRow {
  const record = requireRecord(row, `relational ${label}`);
  const node = parsePresetNode(record);
  const edge = parseOptionalPresetEdge(record);
  return edge ? { edge, node } : { node };
}

/** Normalizes bounded relational preset SQL rows into provider-neutral graph nodes and edges. */
export function normalizePresetRows(
  rows: readonly unknown[],
  limits: { readonly maxEdges: number; readonly maxNodes: number; readonly queryLimit: number },
): {
  readonly rawRows: readonly Readonly<Record<string, unknown>>[];
  readonly result: Pick<GraphPresetReadResult, 'edges' | 'nodes' | 'truncated'>;
} {
  const nodes = new Map<string, GraphReadNode>();
  const edges = new Map<string, GraphReadEdge>();
  const rawRows: Record<string, unknown>[] = [];
  let truncated = rows.length >= limits.queryLimit;

  for (const row of rows) {
    if (!isRecord(row)) {
      throw new Error('Invalid relational preset query row.');
    }
    const parsed = parsePresetQueryRow(row);
    const isNewEdge = !edges.has(parsed.edge.id);
    if (isNewEdge && edges.size >= limits.maxEdges) {
      truncated = true;
      continue;
    }
    const uniqueNewNodeIds = [
      ...new Set(
        [parsed.sourceNode.id, parsed.targetNode.id].filter((nodeId) => !nodes.has(nodeId)),
      ),
    ];
    if (nodes.size + uniqueNewNodeIds.length > limits.maxNodes) {
      truncated = true;
      continue;
    }
    rawRows.push(parsed.rawRow);
    nodes.set(parsed.sourceNode.id, parsed.sourceNode);
    nodes.set(parsed.targetNode.id, parsed.targetNode);
    edges.set(parsed.edge.id, parsed.edge);
  }

  if (nodes.size >= limits.maxNodes) {
    truncated = true;
  }

  const nodeList = [...nodes.values()];
  const nodeIds = new Set(nodeList.map((node) => node.id));
  const edgeList = [...edges.values()].filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );

  return {
    rawRows,
    result: {
      edges: edgeList,
      nodes: nodeList,
      truncated,
    },
  };
}

function parsePresetQueryRow(row: Record<string, unknown>): {
  readonly edge: GraphReadEdge;
  readonly rawRow: Record<string, unknown>;
  readonly sourceNode: GraphReadNode;
  readonly targetNode: GraphReadNode;
} {
  const sourceNodeKey = requireNonEmptyString(row.sourceNodeKey, 'sourceNodeKey');
  const targetNodeKey = requireNonEmptyString(row.targetNodeKey, 'targetNodeKey');
  const sourceKind = requireNonEmptyString(row.sourceKind, 'sourceKind');
  const targetKind = requireNonEmptyString(row.targetKind, 'targetKind');
  const sourceProperties = requireJsonObject(row.sourceProperties, 'sourceProperties');
  const targetProperties = requireJsonObject(row.targetProperties, 'targetProperties');
  const edgeSource = requireNonEmptyString(row.edgeSource, 'edgeSource');
  const edgeTarget = requireNonEmptyString(row.edgeTarget, 'edgeTarget');
  const edgeLabel = requireNonEmptyString(row.edgeLabel, 'edgeLabel');
  const edgeProperties = requireJsonObject(row.edgeProperties, 'edgeProperties');
  const sourceNode = buildReadNode(sourceNodeKey, sourceKind, sourceProperties);
  const targetNode = buildReadNode(targetNodeKey, targetKind, targetProperties);
  const edge: GraphReadEdge = {
    id: stableEdgeId({
      projectScoped: true,
      relationType: edgeLabel,
      sourceNodeKey: edgeSource,
      targetNodeKey: edgeTarget,
    }),
    label: edgeLabel,
    properties: edgeProperties,
    source: edgeSource,
    target: edgeTarget,
  };
  return {
    edge,
    rawRow: {
      edgeLabel,
      edgeProperties: safeJsonPreview(edgeProperties),
      edgeSource,
      edgeTarget,
      sourceNodeKey,
      targetNodeKey,
    },
    sourceNode,
    targetNode,
  };
}

function parsePresetNode(record: Record<string, unknown>): GraphReadNode {
  const nodeId = presetRowNonEmptyString(record.nodeId, 'nodeId');
  const nodeLabel = presetRowNonEmptyString(record.nodeLabel, 'nodeLabel');
  const nodeLabels = record.nodeLabels;
  if (
    !Array.isArray(nodeLabels) ||
    nodeLabels.length === 0 ||
    !nodeLabels.every(isNonEmptyString)
  ) {
    throw new Error('Invalid relational preset row field: nodeLabels');
  }
  const nodeProperties = requireJsonObject(record.nodeProperties, 'nodeProperties');
  return {
    id: nodeId,
    label: nodeLabel,
    labels: [...nodeLabels],
    properties: nodeProperties,
  };
}

function parseOptionalPresetEdge(record: Record<string, unknown>): GraphReadEdge | undefined {
  if (!('edgeSource' in record)) {
    return undefined;
  }
  return {
    id: presetRowNonEmptyString(record.edgeId, 'edgeId'),
    label: presetRowNonEmptyString(record.edgeLabel, 'edgeLabel'),
    properties: requireJsonObject(record.edgeProperties, 'edgeProperties'),
    source: presetRowNonEmptyString(record.edgeSource, 'edgeSource'),
    target: presetRowNonEmptyString(record.edgeTarget, 'edgeTarget'),
  };
}

function presetRowNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid relational preset row field: ${fieldName}`);
  }
  return value;
}

function buildReadNode(
  nodeKey: string,
  kind: string,
  properties: Record<string, unknown>,
): GraphReadNode {
  const graphNodeId = propertyString(properties, 'graphNodeId') ?? nodeKey;
  const normalizedProperties = {
    ...properties,
    graphNodeId,
  };
  return {
    id: nodeKey,
    label: displayNodeLabel(kind, normalizedProperties),
    labels: nodeLabelsFromProperties(normalizedProperties, kind),
    properties: normalizedProperties,
  };
}

function stableEdgeId(input: {
  readonly projectScoped: boolean;
  readonly relationType: string;
  readonly sourceNodeKey: string;
  readonly targetNodeKey: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.projectScoped,
        input.sourceNodeKey,
        input.targetNodeKey,
        input.relationType,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

function requireJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
