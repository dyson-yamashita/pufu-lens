export type GraphTargetSelectionRow = {
  graphNodeId: string;
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
