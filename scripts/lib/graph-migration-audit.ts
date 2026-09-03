import { GRAPH_EDGE_TYPES } from '@pufu-lens/graph';

/** Provider-neutral graph node inventory entry keyed by identity digest only. */
export interface GraphInventoryNode {
  readonly identityDigest: string;
  readonly labels: readonly string[];
  readonly propertyKeys: readonly string[];
}

/** Provider-neutral graph edge inventory entry keyed by endpoint digests and relation type. */
export interface GraphInventoryEdge {
  readonly propertyKeys: readonly string[];
  readonly relationType: string;
  readonly sourceIdentityDigest: string;
  readonly targetIdentityDigest: string;
}

/** Bounded provider-neutral graph inventory without raw node keys or property values. */
export interface GraphInventory {
  readonly edges: readonly GraphInventoryEdge[];
  readonly nodes: readonly GraphInventoryNode[];
  readonly truncated: boolean;
}

/** Source-of-truth audit counts without returning identities or values. */
export interface GraphSourceAuditSummary {
  readonly currentDocumentMissingParsedOrStatus: number;
  readonly currentLifecycleOnlyDocument: number;
  readonly mergedActorAliasReference: number;
  readonly mergedActorEmailQuoteReference: number;
  readonly mergedActorMissingMergeDecision: number;
  readonly relationalDocumentNodeWithoutDocumentRow: number;
}

export type GraphInventoryGateStatus = 'blocked' | 'inconclusive' | 'pass';

/** Sanitized graph inventory comparison summary without identity digests or raw keys. */
export interface GraphInventoryComparisonSummary {
  readonly ageOnlyEdgeCount: number;
  readonly ageOnlyNodeCount: number;
  readonly duplicateEdgeCount: number;
  readonly duplicateNodeCount: number;
  /** Combined count of node label/property-key mismatches and edge property-key mismatches. */
  readonly labelPropertyKeyMismatchCount: number;
  readonly gateStatus: GraphInventoryGateStatus;
  readonly orphanEdgeCount: number;
  readonly relationalOnlyEdgeCount: number;
  readonly relationalOnlyNodeCount: number;
  readonly sourceAudit: GraphSourceAuditSummary;
  readonly truncated: boolean;
  readonly unknownRelationTypeCount: number;
}

const CANONICAL_EDGE_TYPES = new Set<string>(GRAPH_EDGE_TYPES);

/** Normalizes provider label/property-key arrays into sorted unique structural sets. */
export function normalizeStructuralStringSet(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * Compares two provider-neutral graph inventories and source audit counts.
 * SAME_AS edges are canonicalized by unordered endpoint digest pairs; other edges keep direction.
 */
export function compareGraphInventories(input: {
  readonly age: GraphInventory;
  readonly relational: GraphInventory;
  readonly sourceAudit: GraphSourceAuditSummary;
}): GraphInventoryComparisonSummary {
  const ageNodes = input.age.nodes.map(normalizeInventoryNode);
  const relationalNodes = input.relational.nodes.map(normalizeInventoryNode);
  const ageEdges = input.age.edges.map(normalizeInventoryEdge);
  const relationalEdges = input.relational.edges.map(normalizeInventoryEdge);

  const ageNodeIssues = analyzeNodes(ageNodes);
  const relationalNodeIssues = analyzeNodes(relationalNodes);
  const ageEdgeIssues = analyzeEdges(ageEdges);
  const relationalEdgeIssues = analyzeEdges(relationalEdges);

  const ageNodeByDigest = indexNodesByDigest(ageNodes);
  const relationalNodeByDigest = indexNodesByDigest(relationalNodes);
  const ageEdgeByKey = indexEdgesByKey(ageEdges);
  const relationalEdgeByKey = indexEdgesByKey(relationalEdges);

  let ageOnlyNodeCount = 0;
  let relationalOnlyNodeCount = 0;
  let labelPropertyKeyMismatchCount = 0;

  for (const digest of new Set([...ageNodeByDigest.keys(), ...relationalNodeByDigest.keys()])) {
    const ageNode = ageNodeByDigest.get(digest);
    const relationalNode = relationalNodeByDigest.get(digest);
    if (!ageNode) {
      relationalOnlyNodeCount += 1;
      continue;
    }
    if (!relationalNode) {
      ageOnlyNodeCount += 1;
      continue;
    }
    if (
      !sameStringArrays(ageNode.labels, relationalNode.labels) ||
      !sameStringArrays(ageNode.propertyKeys, relationalNode.propertyKeys)
    ) {
      labelPropertyKeyMismatchCount += 1;
    }
  }

  let ageOnlyEdgeCount = 0;
  let relationalOnlyEdgeCount = 0;
  for (const key of new Set([...ageEdgeByKey.keys(), ...relationalEdgeByKey.keys()])) {
    const ageEdge = ageEdgeByKey.get(key);
    const relationalEdge = relationalEdgeByKey.get(key);
    if (ageEdge && !CANONICAL_EDGE_TYPES.has(ageEdge.relationType)) {
      continue;
    }
    if (relationalEdge && !CANONICAL_EDGE_TYPES.has(relationalEdge.relationType)) {
      continue;
    }
    if (!ageEdge) {
      relationalOnlyEdgeCount += 1;
      continue;
    }
    if (!relationalEdge) {
      ageOnlyEdgeCount += 1;
      continue;
    }
    if (!sameStringArrays(ageEdge.propertyKeys, relationalEdge.propertyKeys)) {
      labelPropertyKeyMismatchCount += 1;
    }
  }

  const orphanEdgeCount =
    countOrphanEdges(ageEdges, ageNodeByDigest) +
    countOrphanEdges(relationalEdges, relationalNodeByDigest);
  const truncated = input.age.truncated || input.relational.truncated;
  const duplicateNodeCount = ageNodeIssues.duplicateCount + relationalNodeIssues.duplicateCount;
  const duplicateEdgeCount = ageEdgeIssues.duplicateCount + relationalEdgeIssues.duplicateCount;
  const unknownRelationTypeCount =
    ageEdgeIssues.unknownRelationTypeCount + relationalEdgeIssues.unknownRelationTypeCount;
  const sourceAudit = input.sourceAudit;
  const blockerTotal =
    duplicateNodeCount +
    duplicateEdgeCount +
    orphanEdgeCount +
    unknownRelationTypeCount +
    ageOnlyNodeCount +
    relationalOnlyNodeCount +
    ageOnlyEdgeCount +
    relationalOnlyEdgeCount +
    labelPropertyKeyMismatchCount +
    sumBlockingSourceAuditCounts(sourceAudit);

  const gateStatus: GraphInventoryGateStatus = truncated
    ? 'inconclusive'
    : blockerTotal === 0
      ? 'pass'
      : 'blocked';

  return {
    ageOnlyEdgeCount,
    ageOnlyNodeCount,
    duplicateEdgeCount,
    duplicateNodeCount,
    labelPropertyKeyMismatchCount,
    gateStatus,
    orphanEdgeCount,
    relationalOnlyEdgeCount,
    relationalOnlyNodeCount,
    sourceAudit,
    truncated,
    unknownRelationTypeCount,
  };
}

/** Canonicalizes SAME_AS endpoint digests into an unordered pair key. */
export function canonicalizeInventoryEdgeEndpoints(
  relationType: string,
  sourceIdentityDigest: string,
  targetIdentityDigest: string,
): { readonly sourceIdentityDigest: string; readonly targetIdentityDigest: string } {
  if (relationType !== 'SAME_AS') {
    return { sourceIdentityDigest, targetIdentityDigest };
  }
  return sourceIdentityDigest <= targetIdentityDigest
    ? { sourceIdentityDigest, targetIdentityDigest }
    : { sourceIdentityDigest: targetIdentityDigest, targetIdentityDigest: sourceIdentityDigest };
}

function normalizeInventoryNode(node: GraphInventoryNode): GraphInventoryNode {
  return {
    identityDigest: node.identityDigest,
    labels: normalizeStructuralStringSet(node.labels),
    propertyKeys: normalizeStructuralStringSet(node.propertyKeys),
  };
}

function normalizeInventoryEdge(edge: GraphInventoryEdge): GraphInventoryEdge {
  const endpoints = canonicalizeInventoryEdgeEndpoints(
    edge.relationType,
    edge.sourceIdentityDigest,
    edge.targetIdentityDigest,
  );
  return {
    propertyKeys: normalizeStructuralStringSet(edge.propertyKeys),
    relationType: edge.relationType,
    sourceIdentityDigest: endpoints.sourceIdentityDigest,
    targetIdentityDigest: endpoints.targetIdentityDigest,
  };
}

function analyzeNodes(nodes: readonly GraphInventoryNode[]): { readonly duplicateCount: number } {
  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const node of nodes) {
    if (seen.has(node.identityDigest)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(node.identityDigest);
  }
  return { duplicateCount };
}

function analyzeEdges(edges: readonly GraphInventoryEdge[]): {
  readonly duplicateCount: number;
  readonly unknownRelationTypeCount: number;
} {
  const seen = new Set<string>();
  let duplicateCount = 0;
  let unknownRelationTypeCount = 0;
  for (const edge of edges) {
    if (!CANONICAL_EDGE_TYPES.has(edge.relationType)) {
      unknownRelationTypeCount += 1;
    }
    const key = edgeInventoryKey(edge);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
  }
  return { duplicateCount, unknownRelationTypeCount };
}

function indexNodesByDigest(nodes: readonly GraphInventoryNode[]): Map<string, GraphInventoryNode> {
  const indexed = new Map<string, GraphInventoryNode>();
  for (const node of nodes) {
    if (!indexed.has(node.identityDigest)) {
      indexed.set(node.identityDigest, node);
    }
  }
  return indexed;
}

function indexEdgesByKey(edges: readonly GraphInventoryEdge[]): Map<string, GraphInventoryEdge> {
  const indexed = new Map<string, GraphInventoryEdge>();
  for (const edge of edges) {
    const key = edgeInventoryKey(edge);
    if (!indexed.has(key)) {
      indexed.set(key, edge);
    }
  }
  return indexed;
}

function edgeInventoryKey(edge: GraphInventoryEdge): string {
  const endpoints = canonicalizeInventoryEdgeEndpoints(
    edge.relationType,
    edge.sourceIdentityDigest,
    edge.targetIdentityDigest,
  );
  return `${endpoints.sourceIdentityDigest}\u001f${edge.relationType}\u001f${endpoints.targetIdentityDigest}`;
}

function countOrphanEdges(
  edges: readonly GraphInventoryEdge[],
  nodesByDigest: ReadonlyMap<string, GraphInventoryNode>,
): number {
  let orphanEdgeCount = 0;
  for (const edge of edges) {
    if (
      !nodesByDigest.has(edge.sourceIdentityDigest) ||
      !nodesByDigest.has(edge.targetIdentityDigest)
    ) {
      orphanEdgeCount += 1;
    }
  }
  return orphanEdgeCount;
}

function sameStringArrays(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function sumBlockingSourceAuditCounts(audit: GraphSourceAuditSummary): number {
  return (
    audit.currentDocumentMissingParsedOrStatus +
    audit.mergedActorAliasReference +
    audit.mergedActorEmailQuoteReference +
    audit.mergedActorMissingMergeDecision +
    audit.relationalDocumentNodeWithoutDocumentRow
  );
}
