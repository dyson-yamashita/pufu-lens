export const REPROCESS_WORKFLOW_STEPS = ['collect', 'parse', 'resolve', 'chunk', 'graph'] as const;

export type ReprocessWorkflowStep = (typeof REPROCESS_WORKFLOW_STEPS)[number];

/**
 * Reorders `ingest:reprocess` workflow steps so graph runs before chunk when both are selected.
 *
 * Normal ingest keeps the default parse→resolve→chunk→graph order. Reprocess needs graph while
 * raw documents are still `parsed`, then chunk may process `indexed` raws using the existing contract.
 */
export function normalizeReprocessWorkflowSteps<T extends string>(steps: readonly T[]): T[] {
  if (!steps.includes('graph' as T) || !steps.includes('chunk' as T)) {
    return [...steps];
  }

  const chunkIndex = steps.indexOf('chunk' as T);
  const graphIndex = steps.indexOf('graph' as T);
  const insertIndex = Math.min(chunkIndex, graphIndex);
  const withoutGraphChunk = steps.filter((step) => step !== 'graph' && step !== 'chunk');

  let insertAt = 0;
  for (let index = 0; index < insertIndex; index += 1) {
    const step = steps[index];
    if (step !== 'graph' && step !== 'chunk') {
      insertAt += 1;
    }
  }

  return [
    ...withoutGraphChunk.slice(0, insertAt),
    'graph' as T,
    'chunk' as T,
    ...withoutGraphChunk.slice(insertAt),
  ];
}
