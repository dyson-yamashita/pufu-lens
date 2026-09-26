import {
  type GraphPresetId,
  type GraphReadEdge,
  type GraphReadNode,
  parseGraphPresetReadResult,
  parseGraphReadEdge,
  parseGraphReadNode,
} from '@pufu-lens/graph';
import { type D1Binding, ids, record, rows, text } from './binding.js';

function node(key: unknown, kind: unknown, encoded: unknown): GraphReadNode {
  const id = text(key);
  const properties: Record<string, unknown> = {
    ...record(JSON.parse(text(encoded))),
    graphNodeId: id,
  };
  const label = [
    'title',
    'displayName',
    'display_name',
    'name',
    'canonicalUri',
    'canonical_uri',
    'target',
    'graphNodeId',
  ]
    .map((key) => properties[key])
    .find((value) => typeof value === 'string' && value.trim());
  const fallback = text(kind);
  return parseGraphReadNode({
    id,
    label,
    properties,
    labels: properties.graphLabels ?? [fallback[0]?.toUpperCase() + fallback.slice(1)],
  });
}

/** Reads eligible-document Viewer presets with 501 SQL rows, 500 edges and 600 nodes maximum. */
export async function readD1Preset(
  db: D1Binding,
  input: { projectId: string; presetId: GraphPresetId; documentGraphNodeIds: readonly string[] },
) {
  const eligible = ids(input.documentGraphNodeIds);
  const preview =
    input.presetId === 'actor-documents'
      ? 'actor-documents preset: bounded actor-to-document relations for eligible document graph nodes'
      : 'recent-relations preset: bounded document neighborhood for eligible document graph nodes';
  if (input.documentGraphNodeIds.length === 0) {
    return parseGraphPresetReadResult({
      nodes: [],
      edges: [],
      rawRows: [],
      rowCount: 0,
      truncated: false,
      preview,
    });
  }
  const condition =
    input.presetId === 'actor-documents'
      ? "source.kind='actor' AND target.kind='document' AND target.node_key IN (SELECT value FROM json_each(?2))"
      : `source.kind='document' AND source.node_key IN (SELECT value FROM json_each(?2))
      AND (target.kind IN ('actor','topic') OR (target.kind='document' AND target.node_key IN (SELECT value FROM json_each(?2)) AND source.node_key<=target.node_key))`;
  const join =
    input.presetId === 'actor-documents'
      ? 'source.node_key=e.source_node_key AND target.node_key=e.target_node_key'
      : '((source.node_key=e.source_node_key AND target.node_key=e.target_node_key) OR (source.node_key=e.target_node_key AND target.node_key=e.source_node_key))';
  const result = rows(
    await db
      .prepare(`SELECT source.node_key sk,source.kind sf,source.properties sp,
    target.node_key tk,target.kind tf,target.properties tp,e.source_node_key es,e.target_node_key et,e.relation_type el,e.properties ep
    FROM graph_edges e JOIN graph_nodes source ON source.project_id=e.project_id
    JOIN graph_nodes target ON target.project_id=e.project_id AND ${join}
    WHERE e.project_id=?1 AND ${condition} ORDER BY source.node_key,target.node_key,e.relation_type LIMIT 501`)
      .bind(input.projectId, eligible)
      .all(),
  );
  const nodes = new Map<string, GraphReadNode>();
  const edges = new Map<string, GraphReadEdge>();
  const rawRows: Record<string, unknown>[] = [];
  let truncated = result.length >= 501;
  for (const row of result) {
    const r = record(row);
    const source = node(r.sk, r.sf, r.sp),
      target = node(r.tk, r.tf, r.tp);
    const es = text(r.es),
      et = text(r.et),
      el = text(r.el);
    const hash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([true, es, et, el])),
    );
    const id = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
    const edge = parseGraphReadEdge({
      id,
      source: es,
      target: et,
      label: el,
      properties: JSON.parse(text(r.ep)),
    });
    const newIds = new Set([source.id, target.id].filter((id) => !nodes.has(id)));
    if ((!edges.has(id) && edges.size >= 500) || nodes.size + newIds.size > 600) {
      truncated = true;
      continue;
    }
    nodes.set(source.id, source);
    nodes.set(target.id, target);
    edges.set(id, edge);
    rawRows.push({
      edgeLabel: el,
      edgeProperties: edge.properties,
      edgeSource: es,
      edgeTarget: et,
      sourceNodeKey: source.id,
      targetNodeKey: target.id,
    });
  }
  return parseGraphPresetReadResult({
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    rawRows,
    rowCount: rawRows.length,
    truncated: truncated || nodes.size >= 600,
    preview,
  });
}
