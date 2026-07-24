export type GraphTargetSelectionRow = {
  graphNodeId: string;
  ingestStatus?: string;
};

export type GraphRelatedDocumentTargetSelectionRow = GraphTargetSelectionRow & {
  parsedText: string;
};

export function selectMissingGraphTargets<T extends GraphTargetSelectionRow>(
  rows: readonly T[],
  existingGraphNodeIds: ReadonlySet<string>,
  limit: number,
): T[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid graph target limit: ${limit}`);
  }
  return rows.filter((row) => !existingGraphNodeIds.has(row.graphNodeId)).slice(0, limit);
}

/**
 * Selects graph index targets for missing Document nodes and parsed raw documents that need re-index.
 *
 * Rows with no existing graph node are always selected. Rows whose raw ingest status is `parsed`
 * are also selected even when the Document node already exists, so re-parse workflows can refresh
 * Topic / actor / relation edges before `markIndexed` moves them back to `indexed`.
 */
export function selectGraphIndexTargets<T extends GraphTargetSelectionRow>(
  rows: readonly T[],
  existingGraphNodeIds: ReadonlySet<string>,
  limit: number,
): T[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid graph target limit: ${limit}`);
  }
  const selected: T[] = [];
  for (const row of rows) {
    if (selected.length >= limit) {
      break;
    }
    const nodeExists = existingGraphNodeIds.has(row.graphNodeId);
    if (!nodeExists || row.ingestStatus === 'parsed') {
      selected.push(row);
    }
  }
  return selected;
}

export function selectRelatedDocumentBackfillTargets<
  T extends GraphRelatedDocumentTargetSelectionRow,
>(
  rows: readonly T[],
  existingGraphNodeIds: ReadonlySet<string>,
  missingRelatedEdgeGraphNodeIds: ReadonlySet<string>,
  limit: number,
): T[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Invalid graph target limit: ${limit}`);
  }
  return rows
    .filter(
      (row) =>
        existingGraphNodeIds.has(row.graphNodeId) &&
        missingRelatedEdgeGraphNodeIds.has(row.graphNodeId),
    )
    .slice(0, limit);
}

export function extractRelatedDocumentSourceIds(parsedText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(parsedText);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.relations)) {
    return [];
  }

  const sourceIds: string[] = [];
  const seenSourceIds = new Set<string>();
  for (const relation of parsed.relations) {
    if (
      !isRecord(relation) ||
      relation.type !== 'RELATED_TO' ||
      typeof relation.target !== 'string'
    ) {
      continue;
    }
    const sourceId = relation.target.trim();
    if (!sourceId || seenSourceIds.has(sourceId)) {
      continue;
    }
    seenSourceIds.add(sourceId);
    sourceIds.push(sourceId);
  }
  return sourceIds;
}

export function parseAgtypeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
